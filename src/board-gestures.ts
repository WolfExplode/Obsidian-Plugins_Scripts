import type { App } from "obsidian";
import { attachAltDragDuplicateBlocker } from "./alt-drag";
import { attachContextMenuTrim } from "./context-menu-trim";
import { attachCropDrag } from "./crop-drag";
import { attachDuplicateFinder } from "./duplicate-finder";
import { attachFlipDrag } from "./flip-drag";
import type { HotkeyStore } from "./hotkey-store";
import { attachImageNormalize } from "./image-normalize";
import { attachOpacityKeydown, type OpacityKeydownOptions } from "./opacity-keys";
import { attachPackKeydown } from "./pack-keys";
import { attachTransformKeydown } from "./transform-keys";
import { attachZOrderKeydown } from "./zorder-keys";

export { isEditableTarget } from "./editable-target";

export interface BoardGestureOptions {
	opacity?: OpacityKeydownOptions;
	/** Required in practice — every gesture below reads its trigger binding from this store. */
	hotkeys: HotkeyStore;
}

/**
 * Binds every PureRef Board gesture to one window: pack, z-order, opacity,
 * hold-C crop, Alt+Shift flip, Alt-drag duplicate blocking, Blender-style
 * modal transforms, the Normalize submenu, Find Duplicates, and trimming
 * Cut/Copy/Paste from the context menu. `main.ts` and
 * `popout-manager.ts` both call this instead of wiring each gesture
 * individually, so a Board window and a Popout always get the same set by
 * construction. Order matches the original main.ts wiring.
 *
 * Returns a single disposer that tears down all of them.
 */
export function attachBoardGestures(win: Window, app: App, options: BoardGestureOptions): () => void {
	const { hotkeys } = options;
	const detachers = [
		attachPackKeydown(win, app, hotkeys),
		attachOpacityKeydown(win, app, hotkeys, options.opacity),
		attachZOrderKeydown(win, app, hotkeys),
		attachCropDrag(win, app, hotkeys),
		attachFlipDrag(win, app, hotkeys),
		attachAltDragDuplicateBlocker(win, app),
		attachTransformKeydown(win, app, hotkeys),
		attachImageNormalize(win, app, hotkeys),
		attachDuplicateFinder(win, app, hotkeys),
		attachContextMenuTrim(win, app),
	];
	return () => {
		for (const detach of detachers) detach();
	};
}
