import type { App } from "obsidian";
import { isEditableTarget } from "./editable-target";
import { bringSelectionPastOverlap, findExcalidrawLeafForNode } from "./excalidraw-view";
import { eventMatchesAnyBinding } from "./hotkey-match";
import type { HotkeyStore } from "./hotkey-store";

/**
 * Overlap-aware Ctrl/Cmd+]/[ (Bring Forward / Send Backward) -- see
 * docs/behavior/overlap-aware-zorder.md for why Excalidraw's native one-slot-
 * per-press step needs this: a selection stuck behind a long run of elements
 * it doesn't even overlap otherwise needs one press per element in that run.
 *
 * Deliberately leaves Ctrl+Shift+]/[ (Bring to Front / Send to Back) alone --
 * those already jump straight to the absolute front/back of the whole scene in
 * one native call (moveAllRight/moveAllLeft in zindex.ts), so they don't have
 * this problem.
 *
 * Only claims the key when a move actually happens (mirrors attachPackKeydown).
 * Otherwise Excalidraw's own bubble-phase handler still runs unmodified --
 * e.g. no selection, or the selection touches a group/frame, where
 * bringSelectionPastOverlap deliberately falls back rather than reimplementing
 * Excalidraw's group/frame z-order semantics.
 */
export function attachZOrderKeydown(win: Window, app: App, hotkeys: HotkeyStore): () => void {
	const handler = (event: KeyboardEvent) => {
		const forward = eventMatchesAnyBinding(event, hotkeys.get("zorder-forward"));
		const backward = !forward && eventMatchesAnyBinding(event, hotkeys.get("zorder-backward"));
		if (!forward && !backward) return;
		if (isEditableTarget(event.target)) return;

		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		const direction = forward ? "forward" : "backward";
		if (bringSelectionPastOverlap(leaf, direction)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};

	win.addEventListener("keydown", handler, true);
	return () => win.removeEventListener("keydown", handler, true);
}
