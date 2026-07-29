import type { App } from "obsidian";
import { findExcalidrawLeafForNode } from "./excalidraw-view";

/**
 * `data-testid`s of Excalidraw's native context-menu entries to strip. Keyed
 * on `data-testid` rather than label text because it survives locale changes
 * and label rewording.
 */
const HIDDEN_TESTIDS = ["cut", "copy", "paste", "cropEditor"];

/**
 * Hides Cut / Copy / Paste and Crop image from Excalidraw's native canvas
 * context menu. Cut/Copy/Paste there operate on Excalidraw's own element
 * clipboard (selected elements only), not the OS clipboard, which confused
 * users expecting the usual system copy/paste of an image; those keyboard
 * shortcuts still work. Crop image is redundant with the plugin's own
 * hold-C crop drag gesture and duplicates Excalidraw's double-click-to-crop.
 *
 * These `<li>`s are hidden via CSS (`display: none`), not removed from the
 * DOM. Excalidraw's own render framework owns and tracks this menu's nodes;
 * calling `.remove()` on one leaves the framework's internal tree pointing at
 * a node that's no longer there, and its next reconcile against that stale
 * reference throws (`NotFoundError` on `removeChild`/`insertBefore`) — which,
 * because it happens inside the framework's own commit phase, can corrupt
 * the whole render and blank the canvas until the file is reopened.
 */
export function attachContextMenuTrim(win: Window, app: App): () => void {
	const onContextMenu = (event: MouseEvent) => {
		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		win.setTimeout(() => {
			const menu = win.document.querySelector(".context-menu");
			if (!menu) return;
			for (const testid of HIDDEN_TESTIDS) {
				const item = menu.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
				if (item) item.setCssStyles({ display: "none" });
			}
		}, 0);
	};
	win.addEventListener("contextmenu", onContextMenu, true);
	return () => win.removeEventListener("contextmenu", onContextMenu, true);
}
