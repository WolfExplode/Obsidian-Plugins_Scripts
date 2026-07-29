import type { App } from "obsidian";
import { attachAltDragDuplicateBlocker } from "./alt-drag";
import { attachContextMenuTrim } from "./context-menu-trim";
import { attachCropDrag } from "./crop-drag";
import { attachFlipDrag } from "./flip-drag";
import { attachImageNormalize } from "./image-normalize";
import { attachOpacityKeydown, type OpacityKeydownOptions } from "./opacity-keys";
import { attachPackKeydown } from "./pack-keys";
import { attachTransformKeydown } from "./transform-keys";
import { attachZOrderKeydown } from "./zorder-keys";

export { isEditableTarget } from "./editable-target";

export interface BoardGestureOptions {
	opacity?: OpacityKeydownOptions;
}

/**
 * Binds every PureRef Board gesture to one window: pack, z-order, opacity,
 * hold-C crop, Alt+Shift flip, Alt-drag duplicate blocking, Blender-style
 * modal transforms, the Normalize submenu, and trimming Cut/Copy/Paste from
 * the context menu. `main.ts` and
 * `popout-manager.ts` both call this instead of wiring each gesture
 * individually, so a Board window and a Popout always get the same set by
 * construction. Order matches the original main.ts wiring; it is not
 * arbitrary; see attachTransformKeydown's Alt+R/Alt+S handling for the one
 * case where two modules used to compete for the same key.
 *
 * Returns a single disposer that tears down all of them.
 */
export function attachBoardGestures(win: Window, app: App, options: BoardGestureOptions = {}): () => void {
	const detachers = [
		attachPackKeydown(win, app),
		attachOpacityKeydown(win, app, options.opacity),
		attachZOrderKeydown(win, app),
		attachCropDrag(win, app),
		attachFlipDrag(win, app),
		attachAltDragDuplicateBlocker(win, app),
		attachTransformKeydown(win, app),
		attachImageNormalize(win, app),
		attachContextMenuTrim(win, app),
	];
	return () => {
		for (const detach of detachers) detach();
	};
}
