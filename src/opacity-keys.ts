import type { App } from "obsidian";
import { adjustSelectedElementsOpacity, findExcalidrawLeafForNode } from "./excalidraw-view";

/**
 * Handles Ctrl+minus/plus before Obsidian's command dispatcher sees it. This
 * gives a selection precedence over the PureRef Popout's window-opacity
 * commands, while deliberately leaving an unselected canvas alone.
 */
export interface OpacityKeydownOptions {
	/**
	 * When set, this window owns Ctrl+plus/minus even without a selection. Used
	 * by editable PureRef Popouts so Excalidraw cannot also interpret it as zoom.
	 */
	onNoSelection?: (direction: -1 | 1) => void;
}

export function attachOpacityKeydown(win: Window, app: App, options: OpacityKeydownOptions = {}): () => void {
	const handler = (event: KeyboardEvent) => {
		if (!event.ctrlKey || event.metaKey || event.altKey) return;

		const direction = event.key === "-"
			? -1
			: (event.key === "=" || event.key === "+")
				? 1
				: 0;
		if (direction === 0) return;

		const leaf = findExcalidrawLeafForNode(app, event.target as Node | null);
		const changedSelection = !!leaf && adjustSelectedElementsOpacity(leaf, direction);
		if (!changedSelection && !options.onNoSelection) return;

		// A PureRef Popout owns this key even with no selection. This must run in
		// capture phase so Excalidraw never treats Ctrl+plus/minus as canvas zoom.
		if (!changedSelection) options.onNoSelection?.(direction);

		event.preventDefault();
		event.stopImmediatePropagation();
	};

	win.addEventListener("keydown", handler, true);
	return () => win.removeEventListener("keydown", handler, true);
}
