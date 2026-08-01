import type { App } from "obsidian";
import { isEditableTarget } from "./editable-target";
import {
	clientToSceneCoords,
	findExcalidrawLeafForNode,
	getInteractiveCanvas,
	getSelectedTransformElements,
	installTransformProxy,
	isTransformProxyReady,
	removeTransformProxyEventually,
	resetSelectedImageScale,
	restoreSceneElementsEventually,
	sceneToClientCoords,
	snapshotSceneElements,
	type SceneElement,
	type TransformElement,
} from "./excalidraw-view";
import { eventMatchesAnyBinding } from "./hotkey-match";
import type { HotkeyStore } from "./hotkey-store";
import { leafDocument } from "./leaf-scanner";
import { commonTransformBounds } from "./transform-geometry";

type TransformMode = "move" | "rotate" | "scale";

interface ScenePoint {
	x: number;
	y: number;
}

interface ActiveTransform {
	mode: TransformMode;
	leaf: NonNullable<ReturnType<typeof findExcalidrawLeafForNode>>;
	elements: TransformElement[];
	baseline: readonly SceneElement[];
	pivot: ScenePoint;
	physicalStart: ScenePoint | null;
	physicalCurrent: ScenePoint | null;
	latestShiftKey: boolean;
	nativeOrigin: ScenePoint;
	nativeCurrent: ScenePoint;
	numericInput: string;
	canvas: HTMLCanvasElement;
	cursorDoc: Document;
	hasGesture: boolean;
	nativeDragReady: boolean;
	proxyReady: boolean;
	proxyId: string;
	selectedIds: string[];
	finishing: boolean;
}

/** Events emitted by this bridge must reach Excalidraw, not be recaptured by us. */
const forwardedEvents = new WeakSet<Event>();
let active: ActiveTransform | null = null;
let lastPointer: {
	leaf: NonNullable<ReturnType<typeof findExcalidrawLeafForNode>>;
	x: number;
	y: number;
} | null = null;

function rotate(point: ScenePoint, pivot: ScenePoint, radians: number): ScenePoint {
	const dx = point.x - pivot.x;
	const dy = point.y - pivot.y;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

function selectionPivot(elements: readonly TransformElement[]): ScenePoint {
	const [x1, y1, x2, y2] = commonTransformBounds(elements);
	return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

/** Center of the same native transform handle Excalidraw draws. */
function transformOrigin(mode: TransformMode, elements: readonly TransformElement[], zoom: number): ScenePoint {
	if (mode === "move") return selectionPivot(elements);
	const [x1, y1, x2, y2] = commonTransformBounds(elements);
	return mode === "rotate" ? { x: (x1 + x2) / 2, y: y1 - 22 / zoom } : { x: x2 + 6 / zoom, y: y2 + 6 / zoom };
}

function emitPointer(
	activeTransform: ActiveTransform,
	type: "pointerdown" | "pointermove" | "pointerup",
	scenePoint: ScenePoint,
	source?: Partial<Pick<PointerEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">>,
): void {
	const client = sceneToClientCoords(activeTransform.leaf, scenePoint.x, scenePoint.y);
	const eventWin = activeTransform.cursorDoc.defaultView;
	if (!client || !eventWin) return;
	const isDown = type !== "pointerup";
	const isMove = type === "pointermove";
	const scaleHasImage = activeTransform.elements.some((element) => element.type === "image");
	const event = new eventWin.PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		composed: true,
		// Chromium's real primary mouse is pointer 1. Excalidraw keys its global
		// gesture map and pointer-capture lifecycle by this identity, so inventing
		// an arbitrary pointer id produces a DOM event but not a usable drag.
		pointerId: 1,
		pointerType: "mouse",
		isPrimary: true,
		button: isMove ? -1 : 0,
		buttons: isDown ? 1 : 0,
		pressure: isDown ? 0.5 : 0,
		width: 1,
		height: 1,
		clientX: client.x,
		clientY: client.y,
		ctrlKey: source?.ctrlKey ?? false,
		metaKey: source?.metaKey ?? false,
		shiftKey: activeTransform.mode === "scale" ? !scaleHasImage : (source?.shiftKey ?? false),
		altKey: activeTransform.mode === "scale",
	});
	// The existing Alt-drag duplicate blocker uses this marker for its own
	// replayed events. Center-resize needs a real Alt modifier, so mark our
	// native scale stream as already-normalized and let it pass untouched.
	Object.defineProperty(event, "__eprAltDragRelayed", { value: true });
	forwardedEvents.add(event);
	activeTransform.canvas.dispatchEvent(event);
}

function beginGesture(activeTransform: ActiveTransform): void {
	if (activeTransform.hasGesture) return;
	emitPointer(activeTransform, "pointerdown", activeTransform.nativeOrigin);
	activeTransform.hasGesture = true;
	// A physical pointer cannot move in the same browser task as its down event.
	// React/Excalidraw batches pointer-down state (selectionElement, listeners,
	// pointerDownState) until that task completes. A synchronous virtual move can
	// therefore race the flush and be handled as box selection. Cross one paint
	// boundary before relaying the latest accumulated physical position.
	activeTransform.cursorDoc.defaultView?.requestAnimationFrame(() => {
		if (active !== activeTransform || activeTransform.finishing) return;
		activeTransform.nativeDragReady = true;
		if (activeTransform.mode === "scale" && activeTransform.numericInput) {
			emitPointer(activeTransform, "pointermove", activeTransform.nativeCurrent);
			return;
		}
		if (!activeTransform.physicalCurrent) return;
		activeTransform.nativeCurrent = targetForPointer(activeTransform, activeTransform.physicalCurrent);
		emitPointer(activeTransform, "pointermove", activeTransform.nativeCurrent, {
			shiftKey: activeTransform.latestShiftKey,
		});
	});
}

function targetForPointer(activeTransform: ActiveTransform, current: ScenePoint): ScenePoint {
	const start = activeTransform.physicalStart;
	if (!start) return activeTransform.nativeOrigin;
	if (activeTransform.mode === "move") {
		const dx = current.x - start.x;
		const dy = current.y - start.y;
		return { x: activeTransform.nativeOrigin.x + dx, y: activeTransform.nativeOrigin.y + dy };
	}
	const startDistance = Math.hypot(start.x - activeTransform.pivot.x, start.y - activeTransform.pivot.y);
	if (activeTransform.mode === "scale") {
		const distance = Math.hypot(current.x - activeTransform.pivot.x, current.y - activeTransform.pivot.y);
		return scaleTarget(activeTransform, startDistance < 0.001 ? 1 : distance / startDistance);
	}
	const startAngle = Math.atan2(start.y - activeTransform.pivot.y, start.x - activeTransform.pivot.x);
	const currentAngle = Math.atan2(current.y - activeTransform.pivot.y, current.x - activeTransform.pivot.x);
	const radians = currentAngle - startAngle;
	return rotate(activeTransform.nativeOrigin, activeTransform.pivot, radians);
}

function scaleTarget(activeTransform: ActiveTransform, rawFactor: number): ScenePoint {
	const factor = Math.max(0.01, rawFactor);
	return {
		x: activeTransform.pivot.x + (activeTransform.nativeOrigin.x - activeTransform.pivot.x) * factor,
		y: activeTransform.pivot.y + (activeTransform.nativeOrigin.y - activeTransform.pivot.y) * factor,
	};
}

function releaseStateForDocument(doc: Document): void {
	const isStale = (leaf: ActiveTransform["leaf"]) => {
		const owner = leafDocument(leaf);
		return owner === doc || owner === null;
	};
	if (active && isStale(active.leaf)) {
		restoreSceneElementsEventually(active.leaf, active.baseline);
		removeTransformProxyEventually(active.leaf, active.proxyId, active.selectedIds);
		if (active.hasGesture) emitPointer(active, "pointerup", active.nativeOrigin);
		active.cursorDoc.body.style.removeProperty("cursor");
		active = null;
	}
	if (lastPointer && isStale(lastPointer.leaf)) lastPointer = null;
}

/**
 * Blender-style modal transforms implemented as genuine Excalidraw pointer
 * gestures. The keyboard starts a virtual drag on the native move/rotation/
 * resize handle; physical pointer motion is relayed to that drag. Excalidraw
 * therefore remains responsible for bindings, bound text, frames, snapping,
 * linear points, font sizes, and history, exactly as it is for a mouse gesture.
 */
export function attachTransformKeydown(win: Window, app: App, hotkeys: HotkeyStore): () => void {
	const doc = win.document;
	let suppressNextContextMenu = false;

	const clear = (expected: ActiveTransform) => {
		expected.cursorDoc.body.style.removeProperty("cursor");
		doc.body.style.removeProperty("cursor");
		if (active === expected) active = null;
	};
	const armWhenProxyReady = (expected: ActiveTransform) => {
		const frame = () => {
			if (active !== expected || expected.finishing) return;
			if (!isTransformProxyReady(expected.leaf, expected.proxyId)) {
				expected.cursorDoc.defaultView?.requestAnimationFrame(frame);
				return;
			}
			expected.proxyReady = true;
			if (!expected.physicalStart) return;
			beginGesture(expected);
		};
		expected.cursorDoc.defaultView?.requestAnimationFrame(frame);
	};
	const finish = (cancelled: boolean) => {
		const current = active;
		if (!current || current.finishing) return;
		current.finishing = true;
		if (!current.hasGesture) {
			if (cancelled) restoreSceneElementsEventually(current.leaf, current.baseline);
			removeTransformProxyEventually(current.leaf, current.proxyId, current.selectedIds);
			clear(current);
			return;
		}
		if (cancelled) {
			current.nativeCurrent = current.nativeOrigin;
			emitPointer(current, "pointermove", current.nativeOrigin);
		}
		// Excalidraw throttles pointermove to the animation frame. Ending on the
		// next frame lets its native transform consume the final/cancel position
		// before the equally-native pointerup commits and performs cleanup.
		current.cursorDoc.defaultView?.requestAnimationFrame(() => {
			if (cancelled) restoreSceneElementsEventually(current.leaf, current.baseline);
			removeTransformProxyEventually(current.leaf, current.proxyId, current.selectedIds);
			emitPointer(current, "pointerup", current.nativeCurrent);
			clear(current);
		});
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (active) {
			if (event.key === "Escape" || event.key === "Enter") {
				event.preventDefault();
				event.stopImmediatePropagation();
				finish(event.key === "Escape");
				return;
			}
			if (active.mode === "scale" && !event.ctrlKey && !event.metaKey && !event.altKey) {
				const isDigit = /^\d$/.test(event.key);
				const isDecimalPoint = event.key === "." && !active.numericInput.includes(".");
				if (isDigit || isDecimalPoint || event.key === "Backspace") {
					event.preventDefault();
					event.stopImmediatePropagation();
					active.numericInput = event.key === "Backspace"
						? active.numericInput.slice(0, -1)
						: active.numericInput + event.key;
					const factor = Number(active.numericInput);
					active.nativeCurrent = active.numericInput !== "" && active.numericInput !== "." && Number.isFinite(factor)
						? scaleTarget(active, factor)
						: active.nativeOrigin;
					if (active.proxyReady) {
						beginGesture(active);
						if (active.nativeDragReady) emitPointer(active, "pointermove", active.nativeCurrent);
					}
					return;
				}
			}
			// A modal operator owns the keyboard. In particular Alt+S must never
			// leak to Excalidraw's object-snap toggle while a transform is active.
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}

		if (
			event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat &&
			event.code === "KeyS" && !isEditableTarget(event.target)
		) {
			const resetLeaf = findExcalidrawLeafForNode(app, event.target as Node | null);
			if (!resetLeaf) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			void resetSelectedImageScale(resetLeaf);
			return;
		}
		if (
			!event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
			event.code === "KeyX" && !isEditableTarget(event.target)
		) {
			const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
			if (!leaf) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			(event.target as EventTarget).dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true, cancelable: true }));
			return;
		}
		if (event.repeat || isEditableTarget(event.target)) return;
		const mode: TransformMode | null = eventMatchesAnyBinding(event, hotkeys.get("transform-move"))
			? "move"
			: eventMatchesAnyBinding(event, hotkeys.get("transform-rotate"))
				? "rotate"
				: eventMatchesAnyBinding(event, hotkeys.get("transform-scale")) ? "scale" : null;
		if (!mode) return;
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const elements = getSelectedTransformElements(leaf);
		const baseline = snapshotSceneElements(leaf);
		const canvas = getInteractiveCanvas(leaf);
		const cursorDoc = leafDocument(leaf);
		if (elements.length === 0 || !baseline || !canvas || !cursorDoc || elements.every((element) => element.locked)) return;
		const appState = (leaf.view as unknown as { excalidrawAPI?: { getAppState(): { zoom?: { value?: number } } } }).excalidrawAPI?.getAppState();
		const zoom = appState?.zoom?.value || 1;
		const [x1, y1, x2, y2] = commonTransformBounds(elements);
		const selectedIds = elements.map((element) => element.id);
		const proxyId = installTransformProxy(leaf, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, selectedIds);
		if (!proxyId) return;
		const nativeOrigin = transformOrigin(mode, elements, zoom);
		const pointer = lastPointer?.leaf === leaf ? clientToSceneCoords(leaf, lastPointer.x, lastPointer.y) : null;
		active = {
			mode, leaf, elements, baseline, pivot: selectionPivot(elements), physicalStart: pointer,
			physicalCurrent: pointer, latestShiftKey: false,
			nativeOrigin, nativeCurrent: nativeOrigin, numericInput: "", canvas, cursorDoc,
			hasGesture: false, nativeDragReady: false, proxyReady: false, proxyId, selectedIds, finishing: false,
		};
		cursorDoc.body.style.cursor = mode === "move" ? "move" : mode === "rotate" ? "crosshair" : "nwse-resize";
		armWhenProxyReady(active);
	};

	const onKeyUp = (event: KeyboardEvent) => {
		if (!active) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onPointerMove = (event: PointerEvent) => {
		if (forwardedEvents.has(event)) return;
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (leaf) lastPointer = { leaf, x: event.clientX, y: event.clientY };
		if (!active) return;
		const targetDoc = (event.target as Node | null)?.ownerDocument;
		if (targetDoc !== active.cursorDoc) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		// Commit/cancel waits one frame before its virtual pointerup. Physical
		// movement with the button held can still arrive in that gap; it must be
		// consumed, otherwise Excalidraw applies the real cursor coordinate to the
		// virtual drag immediately before it commits.
		if (active.finishing) return;
		const current = clientToSceneCoords(active.leaf, event.clientX, event.clientY);
		if (!current) return;
		active.physicalCurrent = current;
		active.latestShiftKey = event.shiftKey;
		if (!active.physicalStart) {
			active.physicalStart = current;
			if (active.proxyReady) beginGesture(active);
			return;
		}
		if (active.mode === "scale" && active.numericInput) return;
		active.nativeCurrent = targetForPointer(active, current);
		if (active.proxyReady) {
			beginGesture(active);
			if (active.nativeDragReady) emitPointer(active, "pointermove", active.nativeCurrent, event);
		}
	};

	const onPointerDown = (event: PointerEvent) => {
		if (forwardedEvents.has(event)) return;
		if (!active) {
			suppressNextContextMenu = false;
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		if (event.button === 0) finish(false);
		else if (event.button === 2) {
			suppressNextContextMenu = true;
			finish(true);
		}
	};

	const onPointerUp = (event: PointerEvent) => {
		if (forwardedEvents.has(event) || !active) return;
		// LMB/RMB down commits or cancels the modal operation, but the matching
		// physical release can arrive before our next-frame virtual pointerup.
		// Letting that real coordinate reach Excalidraw finalizes the virtual drag
		// at the cursor and makes the selection centre jump there.
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onContextMenu = (event: MouseEvent) => {
		if (active) {
			event.preventDefault();
			event.stopImmediatePropagation();
			finish(true);
			return;
		}
		if (!suppressNextContextMenu) return;
		suppressNextContextMenu = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const ownsActive = () => !!active && leafDocument(active.leaf) === doc;
	const onBlur = () => {
		if (ownsActive()) finish(true);
	};
	win.addEventListener("keydown", onKeyDown, true);
	win.addEventListener("keyup", onKeyUp, true);
	win.addEventListener("pointermove", onPointerMove, true);
	win.addEventListener("pointerdown", onPointerDown, true);
	win.addEventListener("pointerup", onPointerUp, true);
	win.addEventListener("contextmenu", onContextMenu, true);
	win.addEventListener("blur", onBlur);
	return () => {
		if (ownsActive() && active) {
			restoreSceneElementsEventually(active.leaf, active.baseline);
			removeTransformProxyEventually(active.leaf, active.proxyId, active.selectedIds);
			if (active.hasGesture) emitPointer(active, "pointerup", active.nativeOrigin);
			active.cursorDoc.body.style.removeProperty("cursor");
			active = null;
		}
		releaseStateForDocument(doc);
		win.removeEventListener("keydown", onKeyDown, true);
		win.removeEventListener("keyup", onKeyUp, true);
		win.removeEventListener("pointermove", onPointerMove, true);
		win.removeEventListener("pointerdown", onPointerDown, true);
		win.removeEventListener("pointerup", onPointerUp, true);
		win.removeEventListener("contextmenu", onContextMenu, true);
		win.removeEventListener("blur", onBlur);
	};
}
