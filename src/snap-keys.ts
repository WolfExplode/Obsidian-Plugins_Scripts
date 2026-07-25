import type { App } from "obsidian";
import { findExcalidrawLeafForNode } from "./excalidraw-view";

/**
 * Removes Excalidraw's **Alt+S** "toggle object snap" keyboard shortcut inside a
 * Board.
 *
 * WHY: Excalidraw's snap toggle also force-disables grid mode — its action sets
 * `gridModeEnabled: false` unconditionally (actionToggleObjectsSnapMode.tsx), the
 * mirror of what Ctrl+' does to snap. The two snapping systems are mutually
 * exclusive by Excalidraw's design, so an accidental Alt+S silently turns the grid
 * off. We drop the keyboard trigger so object snap can only be toggled
 * deliberately from the canvas context menu, leaving grid mode untouched.
 *
 * This is an Excalidraw-internal shortcut (not an Obsidian hotkey), so the
 * capture-phase DOM technique used by the pack/transform keys applies: we run
 * before Excalidraw's document-bound, bubble-phase keydown handler and consume the
 * event. Gated to an Excalidraw view so Alt+S is left alone everywhere else. Bound
 * per window (main window and each Popout).
 *
 * Returns a disposer that removes the listener.
 */
export function attachSnapKeyBlocker(win: Window, app: App): () => void {
	const handler = (event: KeyboardEvent) => {
		// Mirror Excalidraw's own keyTest: Alt + S, without Ctrl/Cmd. (Shift is not
		// part of its test, so Alt+Shift+S is caught too, matching Excalidraw.)
		if (event.ctrlKey || event.metaKey || !event.altKey || event.code !== "KeyS") return;
		if (!findExcalidrawLeafForNode(app, event.target as Node | null)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	win.addEventListener("keydown", handler, true);
	return () => win.removeEventListener("keydown", handler, true);
}
