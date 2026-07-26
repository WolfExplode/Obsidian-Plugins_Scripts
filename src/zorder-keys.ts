import type { App } from "obsidian";
import { bringSelectionPastOverlap, findExcalidrawLeafForNode } from "./excalidraw-view";

/** True while focus is in a field where brackets should type, not reorder. */
function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.tagName !== "string") return false;
	return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

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
export function attachZOrderKeydown(win: Window, app: App): () => void {
	const handler = (event: KeyboardEvent) => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
		if (event.code !== "BracketRight" && event.code !== "BracketLeft") return;
		if (isEditableTarget(event.target)) return;

		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;
		const direction = event.code === "BracketRight" ? "forward" : "backward";
		if (bringSelectionPastOverlap(leaf, direction)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};

	win.addEventListener("keydown", handler, true);
	return () => win.removeEventListener("keydown", handler, true);
}
