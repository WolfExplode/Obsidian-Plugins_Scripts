import type { App } from "obsidian";
import { flipImageElements, getImageIds, type ImageFlipAxis } from "./excalidraw-view";
import { attachPointerDrag, findCanvasLeaf } from "./pointer-drag";

/** Ignore a small pointer wobble so Alt+Shift-click remains a no-op. */
const MIN_DRAG_PX = 12;

interface FlipGesture {
	ids: string[];
	leaf: NonNullable<ReturnType<typeof findCanvasLeaf>>;
}

/**
 * PureRef-style image mirroring: Alt+Shift-drag left/right flips selected images
 * horizontally; drag up/down flips them vertically. The gesture is captured
 * before Excalidraw can move the selection.
 */
export function attachFlipDrag(win: Window, app: App): () => void {
	const drag = attachPointerDrag<FlipGesture>(win, {
		onStart(event) {
			if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.button !== 0) return null;
			const leaf = findCanvasLeaf(app, event.target);
			if (!leaf) return null;
			const ids = getImageIds(leaf, true);
			if (ids.length === 0) return null;
			return { ids, leaf };
		},
		onRelease(_event, { ids, leaf }, dx, dy) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) < MIN_DRAG_PX) return;
			const axis: ImageFlipAxis = Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical";
			flipImageElements(leaf, axis, ids);
		},
	});

	return () => drag.dispose();
}
