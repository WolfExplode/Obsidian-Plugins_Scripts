import type { App, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { isExcalidrawLeaf, resetSelectedRotation } from "./excalidraw-view";

/**
 * Owns Alt+R while an Excalidraw Board is active and releases it everywhere
 * else. The reset runs through Obsidian's keymap rather than a DOM listener:
 * Obsidian dispatches registered hotkeys from an earlier window-capture
 * listener, so a conflicting command would otherwise run before this plugin's
 * per-window gesture handlers see the event.
 *
 * Ownership does not depend on whether another command currently uses Alt+R.
 * Board behavior is therefore identical for users with or without Templater:
 * Alt+R resets selected rotation on a Board and remains untouched elsewhere.
 */

/**
 * Retain the original command id so an Obsidian hotkey store written by an
 * older build continues to refer to the live command.
 */
const COMMAND_SUBID = "alt-r-drawing";

/** The minimal slice of Obsidian's untyped HotkeyManager used by this module. */
interface HotkeyManagerLike {
	setHotkeys(commandId: string, hotkeys: { modifiers: string[]; key: string }[]): void;
	removeHotkeys(commandId: string): void;
}

function hotkeyManager(app: App): HotkeyManagerLike | null {
	const hm = (app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager;
	return hm && typeof hm.setHotkeys === "function" && typeof hm.removeHotkeys === "function" ? hm : null;
}

/**
 * Registers the Board-scoped rotation-reset command and its transient Alt+R
 * binding. A no-selection reset is deliberately still consumed: once the
 * Board owns the gesture, falling through based on selection state would make
 * an unrelated command fire unpredictably.
 */
export function attachRotationResetHotkey(plugin: ExcalidrawPureRefPlugin): () => void {
	const app = plugin.app;
	const fullId = `${plugin.manifest.id}:${COMMAND_SUBID}`;

	plugin.addCommand({
		id: COMMAND_SUBID,
		name: "Reset selected rotation",
		callback: () => {
			const leaf = app.workspace.getMostRecentLeaf();
			if (isExcalidrawLeaf(leaf)) resetSelectedRotation(leaf as WorkspaceLeaf);
		},
	});

	let assigned = false;
	const sync = () => {
		const hm = hotkeyManager(app);
		if (!hm) return;
		const boardActive = isExcalidrawLeaf(app.workspace.getMostRecentLeaf());
		if (boardActive && !assigned) {
			try {
				hm.setHotkeys(fullId, [{ modifiers: ["Alt"], key: "r" }]);
				assigned = true;
			} catch {
				/* HotkeyManager shape changed; leave Alt+R to the existing keymap. */
			}
		} else if (!boardActive && assigned) {
			try {
				hm.removeHotkeys(fullId);
			} catch {
				/* The keymap may already be tearing down. */
			}
			assigned = false;
		}
	};

	const refs = [
		app.workspace.on("active-leaf-change", sync),
		app.workspace.on("layout-change", sync),
	];
	sync();

	return () => {
		for (const ref of refs) app.workspace.offref(ref);
		if (assigned) {
			try {
				hotkeyManager(app)?.removeHotkeys(fullId);
			} catch {
				/* The keymap may already be tearing down. */
			}
			assigned = false;
		}
	};
}
