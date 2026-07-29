import type { App } from "obsidian";
import { isEditableTarget } from "./editable-target";
import {
	clientToSceneCoords,
	findExcalidrawLeafForNode,
	getActiveExcalidrawLeaf,
	getImageIds,
	getSelectedImageSceneBBox,
	type SceneRect,
} from "./excalidraw-view";
import {
	cropImagesToSceneRect,
	getNativeCropImageIds,
	getViewportCropImageIds,
	uncropImages,
	type CropResult,
} from "./crop-orchestrator";
import { eventMatchesAnyBinding } from "./hotkey-match";
import type { HotkeyStore } from "./hotkey-store";
import { attachPointerDrag, findCanvasLeaf } from "./pointer-drag";

/**
 * PureRef-style crop: hold **C** and drag a rectangle over the Board; on release
 * every selected image is cropped to the part of it inside that rectangle. If
 * nothing is selected, the gesture is a no-op. It drives the same primitive the
 * debug hook proved — cropImagesToSceneRect — so
 * upright/flipped images use native crop, rotated images use one composed
 * polygon crop, the original is always retained, and it's one undoable step.
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
export function attachCropDrag(win: Window, app: App, hotkeys: HotkeyStore): () => void {
	const doc = win.document;
	let cHeld = false;
	let dragStartX = 0;
	let dragStartY = 0;
	let overlay: HTMLDivElement | null = null;

	const removeOverlay = () => {
		overlay?.remove();
		overlay = null;
	};

	const updateOverlay = (curX: number, curY: number) => {
		if (!overlay) return;
		overlay.style.left = `${Math.min(dragStartX, curX)}px`;
		overlay.style.top = `${Math.min(dragStartY, curY)}px`;
		overlay.style.width = `${Math.abs(curX - dragStartX)}px`;
		overlay.style.height = `${Math.abs(curY - dragStartY)}px`;
	};

	const endDrag = () => {
		removeOverlay();
		doc.body.style.removeProperty("cursor");
	};

	const drag = attachPointerDrag<true>(win, {
		onStart(event) {
			if (!cHeld || event.button !== 0) return null;
			// Only start over the drawing surface itself (a canvas), never
			// Excalidraw's toolbars/menus — those share the view container.
			if (!findCanvasLeaf(app, event.target)) return null;

			dragStartX = event.clientX;
			dragStartY = event.clientY;
			overlay = doc.body.createDiv();
			overlay.style.cssText =
				"position:fixed;z-index:99999;pointer-events:none;box-sizing:border-box;" +
				"border:1px solid var(--interactive-accent,#38bdf8);background:rgba(56,189,248,0.12);";
			updateOverlay(dragStartX, dragStartY);
			return true;
		},
		onMove(event) {
			updateOverlay(event.clientX, event.clientY);
		},
		onRelease(event, _gesture, dx, dy) {
			endDrag();
			const wasDrag = Math.abs(dx) >= MIN_DRAG_PX && Math.abs(dy) >= MIN_DRAG_PX;
			if (!wasDrag) return;

			const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
			const p1 = clientToSceneCoords(leaf, dragStartX, dragStartY);
			const p2 = clientToSceneCoords(leaf, event.clientX, event.clientY);
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
			void cropImagesToSceneRect(app, leaf, rect, selected);
		},
	});

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && drag.isActive()) {
			drag.cancel();
			endDrag();
			return;
		}
		if (event.repeat || isEditableTarget(event.target)) return;
		if (event.key === "Enter") {
			const leaf = getActiveExcalidrawLeaf(app);
			// A custom crop is materialized as an ordinary image, but native crop
			// must not edit that generated PNG. Alt+double-click is the explicit
			// way to remove the custom layer.
			if (getViewportCropImageIds(leaf, true).length) {
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
		}
		if (eventMatchesAnyBinding(event, hotkeys.get("crop-hold"))) {
			cHeld = true;
			// Signal crop mode; Excalidraw may override the cursor over its canvas,
			// which is harmless — the definitive crosshair is the overlay while dragging.
			doc.body.setCssStyles({ cursor: "crosshair" });
		}
	};

	const onDoubleClick = (event: MouseEvent) => {
		const target = event.target as Node | null;
		const leaf = findExcalidrawLeafForNode(app, target);
		if (!leaf) return;

		// Alt+double-click clears either crop layer. Prefer the plugin's custom
		// layer, which restores the underlying native crop if there is one; then
		// clear ordinary native crops. When nothing qualifies, leave the event
		// alone so Excalidraw's own double-click crop editor can still open.
		if (event.altKey) {
			const viewportCropped = getViewportCropImageIds(leaf, true);
			if (viewportCropped.length) {
				event.preventDefault();
				event.stopImmediatePropagation();
				void uncropImages(app, leaf, viewportCropped);
				return;
			}
			const nativeCropped = getNativeCropImageIds(leaf, true);
			if (nativeCropped.length === 0) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			void uncropImages(app, leaf, nativeCropped);
			return;
		}

		// Plain double-click remains available to Excalidraw's native crop editor.
	};

	const onKeyUp = (event: KeyboardEvent) => {
		// Match on the bare key, ignoring modifiers: a keyup's modifier flags aren't
		// reliable (e.g. releasing Ctrl and C near-simultaneously), and PureRef's own
		// hold-C behavior never required the modifiers to still be held to release.
		const heldKey = hotkeys.get("crop-hold")[0]?.key;
		if (heldKey && event.key.toLowerCase() === heldKey.toLowerCase()) {
			cHeld = false;
			if (!drag.isActive()) doc.body.style.removeProperty("cursor");
		}
	};

	const onBlur = () => {
		cHeld = false;
		if (!drag.isActive()) doc.body.style.removeProperty("cursor");
	};

	win.addEventListener("keydown", onKeyDown, true);
	win.addEventListener("keyup", onKeyUp, true);
	win.addEventListener("blur", onBlur, true);
	win.addEventListener("dblclick", onDoubleClick, true);

	return () => {
		drag.dispose();
		endDrag();
		win.removeEventListener("keydown", onKeyDown, true);
		win.removeEventListener("keyup", onKeyUp, true);
		win.removeEventListener("blur", onBlur, true);
		win.removeEventListener("dblclick", onDoubleClick, true);
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
		console.debug(`[EPR crop] ${label}: cropped=${result.cropped.length} skipped=${result.skipped.length}`, result);

	(window as unknown as Record<string, unknown>)[DEBUG_HOOK] = {
		info: () => {
			const leaf = getActiveExcalidrawLeaf(app);
			const bbox = getSelectedImageSceneBBox(leaf);
			console.debug("[EPR crop] active leaf:", !!leaf, "selection bbox:", bbox);
			return bbox;
		},
		crop: async (rect: SceneRect) => {
			const result = await cropImagesToSceneRect(app, getActiveExcalidrawLeaf(app), rect);
			log("crop", result);
			return result;
		},
		cropSelection: async (insetPx = 0) => {
			const leaf = getActiveExcalidrawLeaf(app);
			const bbox = getSelectedImageSceneBBox(leaf);
			if (!bbox) {
				console.debug("[EPR crop] no image selected");
				return null;
			}
			const rect: SceneRect = {
				x: bbox.x + insetPx,
				y: bbox.y + insetPx,
				width: bbox.width - insetPx * 2,
				height: bbox.height - insetPx * 2,
			};
			const result = await cropImagesToSceneRect(app, leaf, rect);
			log(`cropSelection(${insetPx})`, result);
			return result;
		},
		uncrop: async () => {
			const uncropped = await uncropImages(app, getActiveExcalidrawLeaf(app));
			console.debug(`[EPR crop] uncrop: restored=${uncropped.length}`, uncropped);
			return uncropped;
		},
	};

	return () => {
		delete (window as unknown as Record<string, unknown>)[DEBUG_HOOK];
	};
}
