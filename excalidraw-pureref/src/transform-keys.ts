import type { App } from "obsidian";
import {
	applySelectionTransform,
	clientToSceneCoords,
	findExcalidrawLeafForNode,
	getSelectedTransformElements,
	resetSelectedImageScale,
	resetSelectedRotation,
	type TransformElement,
} from "./excalidraw-view";

type TransformMode = "move" | "rotate" | "scale";
const ROTATION_SNAP_RADIANS = 15 * Math.PI / 180;

interface ScenePoint {
	x: number;
	y: number;
}

interface ActiveTransform {
	mode: TransformMode;
	leaf: NonNullable<ReturnType<typeof findExcalidrawLeafForNode>>;
	baseline: TransformElement[];
	pivot: ScenePoint;
	start: ScenePoint | null;
	latest: TransformElement[];
	/** The document we painted the mode cursor on, so clear() can undo it. */
	cursorDoc: Document | null;
}

/**
 * Modal-transform state, deliberately MODULE-level rather than per-instance.
 *
 * WHY: attachTransformKeydown is bound once per window (main window + each
 * Popout), but a Popout's events do not stay in one realm — a real keypress made
 * in a Popout is delivered to the *main* window's listeners, while its pointer
 * events stay in the Popout. With per-instance closures that split the gesture in
 * half: the instance that received the keydown held `active` but never saw the
 * mouse, and the instance seeing the mouse had `active === null`, so G/R/S
 * silently did nothing in a Popout. Sharing the state means whichever instance
 * receives each event drives the same transform.
 */
let active: ActiveTransform | null = null;
/** Last pointer position seen in ANY window, with the leaf it was over. */
let lastPointer: {
	leaf: NonNullable<ReturnType<typeof findExcalidrawLeafForNode>>;
	x: number;
	y: number;
} | null = null;

/** The document owning a leaf's view, where its mode cursor belongs. */
function leafDocument(leaf: ActiveTransform["leaf"]): Document | null {
	return (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument ?? null;
}

function isEditableTarget(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	if (!element || typeof element.tagName !== "string") return false;
	return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}

function selectionCenter(elements: readonly TransformElement[]): ScenePoint {
	const left = Math.min(...elements.map((element) => element.x));
	const top = Math.min(...elements.map((element) => element.y));
	const right = Math.max(...elements.map((element) => element.x + element.width));
	const bottom = Math.max(...elements.map((element) => element.y + element.height));
	return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

function rotate(point: ScenePoint, pivot: ScenePoint, radians: number): ScenePoint {
	const dx = point.x - pivot.x;
	const dy = point.y - pivot.y;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

function transformElements(active: ActiveTransform, current: ScenePoint, snapRotation: boolean): TransformElement[] {
	const start = active.start;
	if (!start) return active.baseline;
	if (active.mode === "move") {
		const dx = current.x - start.x;
		const dy = current.y - start.y;
		return active.baseline.map((element) => ({ ...element, x: element.x + dx, y: element.y + dy }));
	}

	if (active.mode === "rotate") {
		const startAngle = Math.atan2(start.y - active.pivot.y, start.x - active.pivot.x);
		const currentAngle = Math.atan2(current.y - active.pivot.y, current.x - active.pivot.x);
		const rawRadians = currentAngle - startAngle;
		const radians = snapRotation
			? Math.round(rawRadians / ROTATION_SNAP_RADIANS) * ROTATION_SNAP_RADIANS
			: rawRadians;
		return active.baseline.map((element) => {
			const center = rotate({ x: element.x + element.width / 2, y: element.y + element.height / 2 }, active.pivot, radians);
			return {
				...element,
				x: center.x - element.width / 2,
				y: center.y - element.height / 2,
				angle: element.angle + radians,
			};
		});
	}

	const startDistance = Math.hypot(start.x - active.pivot.x, start.y - active.pivot.y);
	const currentDistance = Math.hypot(current.x - active.pivot.x, current.y - active.pivot.y);
	const factor = startDistance < 0.001 ? 1 : Math.max(0.01, currentDistance / startDistance);
	return active.baseline.map((element) => {
		const center = {
			x: active.pivot.x + (element.x + element.width / 2 - active.pivot.x) * factor,
			y: active.pivot.y + (element.y + element.height / 2 - active.pivot.y) * factor,
		};
		const width = Math.max(1, element.width * factor);
		const height = Math.max(1, element.height * factor);
		return { ...element, x: center.x - width / 2, y: center.y - height / 2, width, height };
	});
}

/**
 * Blender-style modal transforms for a selected Excalidraw group:
 * G moves, R rotates, and S uniformly scales about the selection center.
 * Move the pointer to preview, left-click/Enter to commit, or Esc/right-click
 * to restore the exact pre-transform scene.
 *
 * G/R/S/Alt+R/Alt+S all shadow Excalidraw's own shortcuts via a capture-phase
 * DOM race, version-pinned to Excalidraw core 0.18.0 (obsidian-excalidraw-plugin
 * 2.25.3). If these stop working, double-fire with Excalidraw's own actions, or
 * (see onPointerMove below) stop landing in undo history after a version bump,
 * see docs/integrations/excalidraw-shortcut-interception.md for the full
 * mechanism and exact diff targets before re-deriving it from scratch.
 */
export function attachTransformKeydown(win: Window, app: App): () => void {
	const doc = win.document;
	let suppressNextContextMenu = false;

	const clear = () => {
		// Clear the cursor on whichever document we actually painted it on — with a
		// Popout open that is not necessarily this instance's own document.
		active?.cursorDoc?.body.style.removeProperty("cursor");
		doc.body.style.removeProperty("cursor");
		active = null;
	};
	const cancel = () => {
		if (active) applySelectionTransform(active.leaf, active.baseline, "NEVER");
		clear();
	};
	const commit = () => {
		if (active?.start) applySelectionTransform(active.leaf, active.latest, "IMMEDIATELY");
		clear();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (active && event.key === "Escape") {
			event.preventDefault();
			event.stopImmediatePropagation();
			cancel();
			return;
		}
		if (active && event.key === "Enter") {
			event.preventDefault();
			event.stopImmediatePropagation();
			commit();
			return;
		}
		// Blender-style resets, the counterpart to the modal R/S below: Alt+R clears
		// rotation, Alt+S restores native pixel size. Both keys are already reserved
		// inside a Board — Alt+S because Excalidraw's object-snap shortcut is dropped,
		// Alt+R because it is held back from Templater — so consuming them here takes
		// nothing away. Skipped while a modal transform is running, which owns the
		// keyboard until it commits or cancels.
		if (
			!active &&
			event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.shiftKey &&
			!event.repeat &&
			(event.code === "KeyR" || event.code === "KeyS") &&
			!isEditableTarget(event.target)
		) {
			const resetLeaf = findExcalidrawLeafForNode(app, event.target as Node | null);
			if (!resetLeaf) return;
			// Consume unconditionally: these keys must never reach Excalidraw or
			// Obsidian from a Board, even when the selection has nothing to reset.
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.code === "KeyR") resetSelectedRotation(resetLeaf);
			else void resetSelectedImageScale(resetLeaf);
			return;
		}
		if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) return;
		const mode: TransformMode | null = event.code === "KeyG" ? "move" : event.code === "KeyR" ? "rotate" : event.code === "KeyS" ? "scale" : null;
		if (!mode) return;
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		// Always consume R so it cannot fall through to Excalidraw's Rectangle shortcut.
		event.preventDefault();
		event.stopImmediatePropagation();
		const baseline = getSelectedTransformElements(leaf);
		if (baseline.length === 0) return;

		const pointer = lastPointer?.leaf === leaf ? clientToSceneCoords(leaf, lastPointer.x, lastPointer.y) : null;
		// Paint the cursor on the transformed leaf's OWN document, not this
		// instance's: a Popout keypress is delivered to the main window's handler,
		// so `doc` here is often the wrong window entirely.
		const cursorDoc = leafDocument(leaf);
		active = { mode, leaf, baseline, pivot: selectionCenter(baseline), start: pointer, latest: baseline, cursorDoc };
		if (cursorDoc) {
			cursorDoc.body.style.cursor = mode === "move" ? "move" : mode === "rotate" ? "crosshair" : "nwse-resize";
		}
	};

	const onPointerMove = (event: PointerEvent) => {
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (leaf) lastPointer = { leaf, x: event.clientX, y: event.clientY };
		if (!active) return;
		if (leaf !== active.leaf) return;
		const point = clientToSceneCoords(active.leaf, event.clientX, event.clientY);
		if (!point) return;
		if (!active.start) active.start = point;
		active.latest = transformElements(active, point, event.shiftKey && active.mode === "rotate");
		// EVENTUALLY, not NEVER: Excalidraw's store advances its undo snapshot on
		// BOTH "never" and "immediately" (only "eventually" leaves it untouched — see
		// packages/element/src/store.ts processAction, verified against core version
		// 0.18.0 in reference/excalidraw-master — re-check this switch if that file's
		// behavior changes after an obsidian-excalidraw-plugin version bump).
		// Previewing every mouse-move frame with "never" was dragging the snapshot
		// along with the live preview, so by the time commit() fired "immediately"
		// the diff against that snapshot was empty and nothing ever reached the undo
		// stack.
		applySelectionTransform(active.leaf, active.latest, "EVENTUALLY");
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onPointerDown = (event: PointerEvent) => {
		if (!active) {
			suppressNextContextMenu = false;
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		if (event.button === 0) commit();
		else if (event.button === 2) {
			suppressNextContextMenu = true;
			cancel();
		}
	};

	const onContextMenu = (event: MouseEvent) => {
		if (active) {
			event.preventDefault();
			event.stopImmediatePropagation();
			cancel();
			return;
		}
		if (!suppressNextContextMenu) return;
		suppressNextContextMenu = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	/**
	 * Whether the in-flight transform is being applied to a leaf in THIS window.
	 * Now that the state is shared, blur/teardown must not tear down a transform
	 * another window owns — a Popout keypress activates via the main window's
	 * handler, so the main window blurring (because the Popout took focus) must
	 * leave that Popout transform running.
	 */
	const ownsActive = () => !!active && leafDocument(active.leaf) === doc;

	const onBlur = () => {
		if (ownsActive()) cancel();
	};
	win.addEventListener("keydown", onKeyDown, true);
	win.addEventListener("pointermove", onPointerMove, true);
	win.addEventListener("pointerdown", onPointerDown, true);
	win.addEventListener("contextmenu", onContextMenu, true);
	win.addEventListener("blur", onBlur);
	return () => {
		if (ownsActive()) cancel();
		win.removeEventListener("keydown", onKeyDown, true);
		win.removeEventListener("pointermove", onPointerMove, true);
		win.removeEventListener("pointerdown", onPointerDown, true);
		win.removeEventListener("contextmenu", onContextMenu, true);
		win.removeEventListener("blur", onBlur);
	};
}
