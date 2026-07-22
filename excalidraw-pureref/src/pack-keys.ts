import type { App } from "obsidian";
import { findExcalidrawLeafForNode, packSelectedElements } from "./excalidraw-view";
import type { PackDirection } from "./pack-elements";

const KEY_TO_DIRECTION: Record<string, PackDirection> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
};

/** True while focus is in a field where arrows should type/navigate, not pack. */
function isEditableTarget(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.tagName !== "string") return false;
	return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

/**
 * Binds the PureRef-style Ctrl+Arrow pack to a window (the main window or a
 * Popout — each gets its own binding). We intercept in the *capture* phase on
 * the window so we run before Excalidraw's own keydown handler (bound on
 * `document` in the bubble phase), which otherwise nudges the selected elements
 * by a step and calls preventDefault. When a pack actually happens we
 * stopImmediatePropagation + preventDefault so Excalidraw never sees the key;
 * otherwise we stay out of the way and let its normal arrow behavior run.
 *
 * Returns a disposer that removes the listener.
 */
export function attachPackKeydown(win: Window, app: App): () => void {
	const handler = (event: KeyboardEvent) => {
		const direction = KEY_TO_DIRECTION[event.key];
		if (!direction) return;
		// Ctrl (or Cmd) only — plain arrows nudge, Shift/Alt are other modifiers.
		if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
		if (isEditableTarget(event.target)) return;

		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		if (!leaf) return;

		if (packSelectedElements(leaf, direction)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};

	win.addEventListener("keydown", handler, true);
	return () => win.removeEventListener("keydown", handler, true);
}
