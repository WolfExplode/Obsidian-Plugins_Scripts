import type { App } from "obsidian";
import { isEditableTarget } from "./editable-target";
import {
	applySelectionTransform,
	clientToSceneCoords,
	findExcalidrawLeafForNode,
	getEffectiveGridSize,
	getSelectedTransformElements,
	resetSelectedImageScale,
	resetSelectedRotation,
	type TransformElement,
} from "./excalidraw-view";
import { leafDocument } from "./leaf-scanner";

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
	/** Textual scale factor entered while the Scale operator is active. */
	numericInput: string;
	/** Whether a preview has been applied and therefore needs committing. */
	hasPreview: boolean;
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

/**
 * Drops shared state pointing into a window that is going away.
 *
 * Both `active` and `lastPointer` hold a WorkspaceLeaf, and a leaf transitively
 * retains its whole Excalidraw view and scene. `active` is cleared by the normal
 * commit/cancel paths, but `lastPointer` is only ever overwritten — so without
 * this a closed Popout's leaf stays reachable until the pointer next moves over a
 * different one. Called from each window's disposer with that window's document.
 * A leaf whose view no longer reports a document is treated as stale regardless
 * of which disposer noticed it.
 */
function releaseStateForDocument(doc: Document): void {
	const isStale = (leaf: ActiveTransform["leaf"]) => {
		const owner = leafDocument(leaf);
		return owner === doc || owner === null;
	};
	if (active && isStale(active.leaf)) {
		active.cursorDoc?.body.style.removeProperty("cursor");
		active = null;
	}
	if (lastPointer && isStale(lastPointer.leaf)) lastPointer = null;
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

function transformElements(active: ActiveTransform, current: ScenePoint, shiftKey: boolean): TransformElement[] {
	const start = active.start;
	if (!start) return active.baseline;
	if (active.mode === "move") {
		const gridSize = getEffectiveGridSize(active.leaf);
		let dx = current.x - start.x;
		let dy = current.y - start.y;
		// Match Excalidraw's native selected-element drag: Shift preserves only
		// the dominant movement axis, before the delta is snapped to the grid.
		if (shiftKey) {
			if (Math.abs(dx) < Math.abs(dy)) dx = 0;
			else if (Math.abs(dx) > Math.abs(dy)) dy = 0;
		}
		if (gridSize) {
			dx = Math.round(dx / gridSize) * gridSize;
			dy = Math.round(dy / gridSize) * gridSize;
		}
		return active.baseline.map((element) => ({ ...element, x: element.x + dx, y: element.y + dy }));
	}

	if (active.mode === "rotate") {
		const startAngle = Math.atan2(start.y - active.pivot.y, start.x - active.pivot.x);
		const currentAngle = Math.atan2(current.y - active.pivot.y, current.x - active.pivot.x);
		const rawRadians = currentAngle - startAngle;
		const radians = shiftKey
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
	const factor = startDistance < 0.001 ? 1 : currentDistance / startDistance;
	return scaleElements(active, factor);
}

/** Uniformly scales the original selection around its center pivot. */
function scaleElements(active: ActiveTransform, rawFactor: number): TransformElement[] {
	// Excalidraw elements cannot have zero-sized bounds. Keep the same lower
	// bound used by pointer-driven scaling, including for a typed `0`.
	const factor = Math.max(0.01, rawFactor);
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
		if (active?.hasPreview) applySelectionTransform(active.leaf, active.latest, "IMMEDIATELY");
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
		// Like Blender's Scale operator, numbers entered during S are absolute
		// multipliers of the geometry at the start of this operation: `.5` is
		// 50%, `2` is 200%. Once a number is being entered, the pointer no longer
		// changes the preview, so it is safe to refine the number with Backspace.
		if (active?.mode === "scale" && !event.ctrlKey && !event.metaKey && !event.altKey) {
			const isDigit = /^\d$/.test(event.key);
			const isDecimalPoint = event.key === "." && !active.numericInput.includes(".");
			if (isDigit || isDecimalPoint || event.key === "Backspace") {
				event.preventDefault();
				event.stopImmediatePropagation();
				const next = event.key === "Backspace"
					? active.numericInput.slice(0, -1)
					: active.numericInput + event.key;
				active.numericInput = next;
				const factor = Number(next);
				if (next !== "" && next !== "." && Number.isFinite(factor)) {
					active.latest = scaleElements(active, factor);
					active.hasPreview = true;
					applySelectionTransform(active.leaf, active.latest, "EVENTUALLY");
				} else if (next === "") {
					active.latest = active.baseline;
					active.hasPreview = false;
					applySelectionTransform(active.leaf, active.baseline, "EVENTUALLY");
				}
				return;
			}
		}
		// Blender-style resets, the counterpart to the modal R/S below: Alt+R clears
		// rotation, Alt+S restores native pixel size. Both keys are already reserved
		// inside a Board — Alt+R because it is held back from Templater (see alt-r.ts)
		// — so consuming them here takes nothing away. This also incidentally drops
		// Excalidraw's own Alt+S "toggle object snap" shortcut, which is the point:
		// that action force-disables grid mode unconditionally
		// (actionToggleObjectsSnapMode.tsx), so an accidental Alt+S would silently
		// turn the grid off. Consuming Alt+S here, unconditionally and before
		// Excalidraw's own bubble-phase handler runs, is what prevents that — a
		// separate snap-keys.ts module used to do this same consume but registered
		// after this one, so it never actually ran; it was removed rather than kept
		// as dead code. Skipped while a modal transform is running, which owns the
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
		// X natively activates the freedraw tool (Tools.tsx TOOLS.freedraw.letterKey is
		// [P, X]) — we want it to delete the selection instead. Rather than reimplement
		// actionDeleteSelected's frame/binding/group logic, swallow X and re-dispatch a
		// synthetic Delete keydown at the same target so Excalidraw's own unmodified
		// handler performs the deletion. Skipped while a modal transform is running,
		// same as Alt+R/S above.
		if (
			!active &&
			!event.repeat &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!event.shiftKey &&
			event.code === "KeyX" &&
			!isEditableTarget(event.target)
		) {
			const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
			if (!leaf) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			(event.target as EventTarget).dispatchEvent(
				new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true, cancelable: true }),
			);
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
		// Switching operators is a cancel, not a commit. Restore the original
		// scene before taking the new baseline so (for example) S → G drops the
		// uncommitted scale preview and starts a fresh move from the pre-scale
		// geometry.
		if (active) cancel();
		const baseline = getSelectedTransformElements(leaf);
		if (baseline.length === 0) return;

		const pointer = lastPointer?.leaf === leaf ? clientToSceneCoords(leaf, lastPointer.x, lastPointer.y) : null;
		// Paint the cursor on the transformed leaf's OWN document, not this
		// instance's: a Popout keypress is delivered to the main window's handler,
		// so `doc` here is often the wrong window entirely.
		const cursorDoc = leafDocument(leaf);
		active = { mode, leaf, baseline, pivot: selectionCenter(baseline), start: pointer, latest: baseline, numericInput: "", hasPreview: false, cursorDoc };
		if (cursorDoc) {
			cursorDoc.body.style.cursor = mode === "move" ? "move" : mode === "rotate" ? "crosshair" : "nwse-resize";
		}
	};

	const onPointerMove = (event: PointerEvent) => {
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (leaf) lastPointer = { leaf, x: event.clientX, y: event.clientY };
		if (!active) return;
		if (leaf !== active.leaf) return;
		if (active.mode === "scale" && active.numericInput) {
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		const point = clientToSceneCoords(active.leaf, event.clientX, event.clientY);
		if (!point) return;
		if (!active.start) active.start = point;
		active.latest = transformElements(active, point, event.shiftKey);
		active.hasPreview = true;
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
		// Restore the scene first if this window owns the in-flight transform, then
		// drop any remaining shared references into this window (see
		// releaseStateForDocument) so its leaf isn't retained after teardown.
		if (ownsActive()) cancel();
		releaseStateForDocument(doc);
		win.removeEventListener("keydown", onKeyDown, true);
		win.removeEventListener("pointermove", onPointerMove, true);
		win.removeEventListener("pointerdown", onPointerDown, true);
		win.removeEventListener("contextmenu", onContextMenu, true);
		win.removeEventListener("blur", onBlur);
	};
}
