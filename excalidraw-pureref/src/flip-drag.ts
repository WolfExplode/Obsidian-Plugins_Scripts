import type { App } from "obsidian";
import {
	findExcalidrawLeafForNode,
	flipImageElements,
	getImageIds,
	type ImageFlipAxis,
} from "./excalidraw-view";

/** Ignore a small pointer wobble so Alt+Shift-click remains a no-op. */
const MIN_DRAG_PX = 12;

/**
 * PureRef-style image mirroring: Alt+Shift-drag left/right flips selected images
 * horizontally; drag up/down flips them vertically. The gesture is captured
 * before Excalidraw can move the selection.
 */
export function attachFlipDrag(win: Window, app: App): () => void {
	let gesture: { startX: number; startY: number; ids: string[]; leaf: ReturnType<typeof findExcalidrawLeafForNode> } | null = null;

	const onPointerDown = (event: PointerEvent) => {
		if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (!target || target.tagName !== "CANVAS") return;
		const leaf = findExcalidrawLeafForNode(app, target);
		const ids = getImageIds(leaf, true);
		if (!leaf || ids.length === 0) return;

		gesture = { startX: event.clientX, startY: event.clientY, ids, leaf };
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!gesture) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!gesture) return;
		const { startX, startY, ids, leaf } = gesture;
		gesture = null;
		const dx = event.clientX - startX;
		const dy = event.clientY - startY;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (Math.max(Math.abs(dx), Math.abs(dy)) < MIN_DRAG_PX) return;
		const axis: ImageFlipAxis = Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical";
		flipImageElements(leaf, axis, ids);
	};

	win.addEventListener("pointerdown", onPointerDown, true);
	win.addEventListener("pointermove", onPointerMove, true);
	win.addEventListener("pointerup", onPointerUp, true);
	return () => {
		gesture = null;
		win.removeEventListener("pointerdown", onPointerDown, true);
		win.removeEventListener("pointermove", onPointerMove, true);
		win.removeEventListener("pointerup", onPointerUp, true);
	};
}
