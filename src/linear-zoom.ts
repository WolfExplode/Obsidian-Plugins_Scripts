import type { App, WorkspaceLeaf } from "obsidian";
import { findExcalidrawLeafForNode, zoomAtClientPoint } from "./excalidraw-view";

// Match Excalidraw's base wheel calculation (including its per-event cap), but
// deliberately omit its extra log10(zoom) term. That term makes wheel zoom
// accelerate above 100%, which is useful for very large canvases but feels
// unlike PureRef's consistent wheel response.
const MAX_WHEEL_DELTA = 10;

/**
 * Replaces Excalidraw's wheel/pinch zoom only in an editable PureRef Popout.
 * It is attached on the window in capture phase so the bundled Excalidraw
 * handler never sees a zoom wheel event. Normal Excalidraw leaves retain their
 * native zoom behavior.
 */
export function attachLinearPopoutZoom(win: Window, app: App, popoutLeaf: WorkspaceLeaf): () => void {
	const onWheel = (event: WheelEvent) => {
		// Excalidraw treats Ctrl/Cmd+wheel (and Chromium pinch, which sets ctrlKey)
		// as zoom. Do not change ordinary canvas scrolling/panning gestures.
		if (!event.ctrlKey && !event.metaKey) return;
		if (findExcalidrawLeafForNode(app, event.target as Node | null) !== popoutLeaf) return;
		if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;

		const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY));
		if (!zoomAtClientPoint(popoutLeaf, event.clientX, event.clientY, -delta / 100)) return;

		event.preventDefault();
		event.stopImmediatePropagation();
	};

	win.addEventListener("wheel", onWheel, { capture: true, passive: false });
	return () => win.removeEventListener("wheel", onWheel, true);
}
