import type { App } from "obsidian";
import {
	clientToSceneCoords,
	cropImagesToSceneRect,
	findExcalidrawLeafForNode,
	getActiveExcalidrawLeaf,
	getImageIds,
	getSelectedImageSceneBBox,
	uncropImages,
	type CropResult,
	type SceneRect,
} from "./excalidraw-view";

/**
 * PureRef-style crop: hold **C** and drag a rectangle over the Board; on release
 * every selected image is cropped to the part of it inside that rectangle. If
 * nothing is selected, the gesture is a no-op. It drives the same primitive the
 * debug hook proved — cropImagesToSceneRect — so
 * upright/flipped images crop exactly, rotated ones are skipped, the original is
 * always retained (double-click re-exposes it), and it's one undoable step.
 *
 * Bound per window (main window and each Popout, like attachPackKeydown) so the
 * Popout inherits the feature for free. The marquee overlay lives in that
 * window's own document.
 */

/** Below this client-pixel drag distance we treat the gesture as a click (no crop). */
const MIN_DRAG_PX = 4;

/**
 * Installs the hold-C crop-drag on one window. `C` held only gates the *start* of
 * a drag; releasing it mid-drag still completes the crop on pointer-up (matching
 * PureRef). Returns a disposer.
 */
export function attachCropDrag(win: Window, app: App): () => void {
	const doc = win.document;
	let cHeld = false;
	let dragging = false;
	let startX = 0;
	let startY = 0;
	let overlay: HTMLDivElement | null = null;

	const isEditableTarget = (target: EventTarget | null): boolean => {
		const el = target as HTMLElement | null;
		if (!el || typeof el.tagName !== "string") return false;
		return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
	};

	const removeOverlay = () => {
		overlay?.remove();
		overlay = null;
	};

	const updateOverlay = (curX: number, curY: number) => {
		if (!overlay) return;
		overlay.style.left = `${Math.min(startX, curX)}px`;
		overlay.style.top = `${Math.min(startY, curY)}px`;
		overlay.style.width = `${Math.abs(curX - startX)}px`;
		overlay.style.height = `${Math.abs(curY - startY)}px`;
	};

	const endDrag = () => {
		dragging = false;
		removeOverlay();
		doc.body.style.removeProperty("cursor");
	};

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && dragging) {
			endDrag();
			return;
		}
		if (event.repeat || isEditableTarget(event.target)) return;
		if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.metaKey && !event.altKey) {
			cHeld = true;
			// Signal crop mode; Excalidraw may override the cursor over its canvas,
			// which is harmless — the definitive crosshair is the overlay while dragging.
			doc.body.style.cursor = "crosshair";
		}
	};

	const onKeyUp = (event: KeyboardEvent) => {
		if (event.key.toLowerCase() === "c") {
			cHeld = false;
			if (!dragging) doc.body.style.removeProperty("cursor");
		}
	};

	const onBlur = () => {
		cHeld = false;
		if (!dragging) doc.body.style.removeProperty("cursor");
	};

	const onPointerDown = (event: PointerEvent) => {
		if (!cHeld || event.button !== 0 || dragging) return;
		// Only start over the drawing surface itself (a canvas), never Excalidraw's
		// toolbars/menus — those share the view container.
		const target = event.target as HTMLElement | null;
		if (!target || target.tagName !== "CANVAS") return;
		if (!findExcalidrawLeafForNode(app, target)) return;

		dragging = true;
		startX = event.clientX;
		startY = event.clientY;
		overlay = doc.createElement("div");
		overlay.style.cssText =
			"position:fixed;z-index:99999;pointer-events:none;box-sizing:border-box;" +
			"border:1px solid var(--interactive-accent,#38bdf8);background:rgba(56,189,248,0.12);";
		updateOverlay(startX, startY);
		doc.body.appendChild(overlay);

		// Preempt Excalidraw's own pointer handling (which would start a selection
		// box or drag the element and clear our selection).
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!dragging) return;
		updateOverlay(event.clientX, event.clientY);
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!dragging) return;
		const endX = event.clientX;
		const endY = event.clientY;
		const wasDrag = Math.abs(endX - startX) >= MIN_DRAG_PX && Math.abs(endY - startY) >= MIN_DRAG_PX;
		endDrag();
		event.preventDefault();
		event.stopImmediatePropagation();
		if (!wasDrag) return;

		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		const p1 = clientToSceneCoords(leaf, startX, startY);
		const p2 = clientToSceneCoords(leaf, endX, endY);
		if (!p1 || !p2) return;
		const rect: SceneRect = {
			x: Math.min(p1.x, p2.x),
			y: Math.min(p1.y, p2.y),
			width: Math.abs(p2.x - p1.x),
			height: Math.abs(p2.y - p1.y),
		};
		// Crop only the images selected when the gesture completes. An empty
		// selection must be a no-op; never fall back to all images on the board.
		const selected = getImageIds(leaf, true);
		if (selected.length === 0) return;
		void cropImagesToSceneRect(leaf, rect, selected);
	};

	win.addEventListener("keydown", onKeyDown, true);
	win.addEventListener("keyup", onKeyUp, true);
	win.addEventListener("blur", onBlur, true);
	win.addEventListener("pointerdown", onPointerDown, true);
	win.addEventListener("pointermove", onPointerMove, true);
	win.addEventListener("pointerup", onPointerUp, true);

	return () => {
		endDrag();
		win.removeEventListener("keydown", onKeyDown, true);
		win.removeEventListener("keyup", onKeyUp, true);
		win.removeEventListener("blur", onBlur, true);
		win.removeEventListener("pointerdown", onPointerDown, true);
		win.removeEventListener("pointermove", onPointerMove, true);
		win.removeEventListener("pointerup", onPointerUp, true);
	};
}

/**
 * Live console hook, kept alongside the marquee so the crop primitive can still be
 * exercised directly across main + popout without a pointer gesture. Usage:
 *   __eprCropDebug.info()             // selected images + selection bbox
 *   __eprCropDebug.cropSelection(20)  // crop selection to its shared box, inset 20px
 *   __eprCropDebug.crop({x,y,width,height})
 *   __eprCropDebug.uncrop()           // re-expose every original
 */
const DEBUG_HOOK = "__eprCropDebug";

export function installCropDebugHook(app: App): () => void {
	const log = (label: string, result: CropResult) =>
		console.log(`[EPR crop] ${label}: cropped=${result.cropped.length} skipped=${result.skipped.length}`, result);

	(window as unknown as Record<string, unknown>)[DEBUG_HOOK] = {
		info: () => {
			const leaf = getActiveExcalidrawLeaf(app);
			const bbox = getSelectedImageSceneBBox(leaf);
			console.log("[EPR crop] active leaf:", !!leaf, "selection bbox:", bbox);
			return bbox;
		},
		crop: async (rect: SceneRect) => {
			const result = await cropImagesToSceneRect(getActiveExcalidrawLeaf(app), rect);
			log("crop", result);
			return result;
		},
		cropSelection: async (insetPx = 0) => {
			const leaf = getActiveExcalidrawLeaf(app);
			const bbox = getSelectedImageSceneBBox(leaf);
			if (!bbox) {
				console.log("[EPR crop] no image selected");
				return null;
			}
			const rect: SceneRect = {
				x: bbox.x + insetPx,
				y: bbox.y + insetPx,
				width: bbox.width - insetPx * 2,
				height: bbox.height - insetPx * 2,
			};
			const result = await cropImagesToSceneRect(leaf, rect);
			log(`cropSelection(${insetPx})`, result);
			return result;
		},
		uncrop: () => {
			const uncropped = uncropImages(getActiveExcalidrawLeaf(app));
			console.log(`[EPR crop] uncrop: restored=${uncropped.length}`, uncropped);
			return uncropped;
		},
	};

	return () => {
		delete (window as unknown as Record<string, unknown>)[DEBUG_HOOK];
	};
}
