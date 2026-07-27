import type { App } from "obsidian";
import { isEditableTarget } from "./editable-target";
import {
	findExcalidrawLeafForNode,
	optimalPackSelectedElements,
	packSelectedElements,
} from "./excalidraw-view";
import type { PackDirection } from "./pack-elements";

const KEY_TO_DIRECTION: Record<string, PackDirection> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
};

/**
 * Binds the PureRef arranges to a window (the main window or a Popout — each
 * gets its own binding):
 *   - Ctrl/Cmd + Arrow   → gravity pack toward that direction
 *   - Ctrl/Cmd + Shift + P → "Optimal" compact arrange
 *
 * We intercept in the *capture* phase on the window so we run before Excalidraw's
 * own keydown handler (bound on `document` in the bubble phase, which nudges
 * selected elements on arrows) and before Obsidian's command dispatch (which
 * owns Ctrl+Shift+P). Only when an arrange actually happens do we
 * stopImmediatePropagation + preventDefault so the key is fully consumed;
 * otherwise we stay out of the way and let normal behavior run.
 *
 * Returns a disposer that removes the listener.
 */
export function attachPackKeydown(win: Window, app: App): () => void {
	const handler = (event: KeyboardEvent) => {
		// Ctrl (or Cmd) is required for every arrange; Alt never is.
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
		if (isEditableTarget(event.target)) return;

		const run = (): boolean => {
			// Optimal arrange: Ctrl/Cmd+Shift+P (KeyP is layout-independent).
			if (event.shiftKey) {
				if (event.code !== "KeyP") return false;
				const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
				return !!leaf && optimalPackSelectedElements(leaf);
			}
			// Gravity pack: Ctrl/Cmd+Arrow (no Shift).
			const direction = KEY_TO_DIRECTION[event.key];
			if (!direction) return false;
			const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
			return !!leaf && packSelectedElements(leaf, direction);
		};

		if (run()) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};

	win.addEventListener("keydown", handler, true);
	return () => win.removeEventListener("keydown", handler, true);
}
