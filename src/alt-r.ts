import type { App, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { isExcalidrawLeaf } from "./excalidraw-view";

/**
 * Claims **Alt+R** while an Excalidraw drawing is the active leaf, so it stops
 * reaching Templater (whose Alt+R "Replace templates in the active file" errors
 * with "Active editor is null" on a drawing — there is no markdown editor). The
 * key is reserved here for a PureRef feature; the action is delegated to `onAltR`.
 *
 * WHY NOT A DOM keydown LISTENER (the first, failed attempt): Obsidian's own
 * `Keymap.onKeyEvent` is a window-capture listener registered at startup — before
 * any plugin — and once it matches a registered hotkey it runs the command and
 * `stopImmediatePropagation`s. A plugin's later-registered capture listener never
 * sees the event. (That's also why pack/transform keys DO work via DOM capture:
 * their keys aren't Obsidian hotkeys, so onKeyEvent ignores them and lets them
 * through.) Alt+R *is* an Obsidian hotkey, so it must be intercepted inside the
 * keymap, not the DOM.
 *
 * HOW IT WORKS: we register a real command and toggle its hotkey by mode.
 *   - `HotkeyManager.onTrigger` iterates baked hotkeys and stops at the FIRST
 *     match whose command executes (executeCommand returns true unless it throws —
 *     a checkCallback returning false does NOT fall through). So whoever is baked
 *     first and runs, wins.
 *   - `bake()` bakes the custom-keys store before defaults, so a hotkey assigned
 *     via `setHotkeys` outranks Templater's default Alt+R.
 *   - `setHotkeys`/`removeHotkeys` mutate only the in-memory store and invalidate
 *     the bake; they do NOT persist to hotkeys.json.
 * So: while a drawing is active we `setHotkeys` our command (baked first → wins,
 * Templater blocked); otherwise we `removeHotkeys` it (Templater's Alt+R is the
 * only match → Templater runs normally). Toggled on active-leaf / layout changes.
 *
 * This rides Obsidian's global keymap, which already spans popout windows, so a
 * single registration covers the main window and every popout — no per-window
 * wiring needed. No dependency on the Excalidraw plugin's code (ADR 0001): the
 * mode test is just the leaf's view type via `isExcalidrawLeaf`.
 */

/** Sub-id under the plugin namespace; the full command id is `${manifest.id}:${SUBID}`. */
const COMMAND_SUBID = "alt-r-drawing";

/** The minimal slice of Obsidian's (untyped) HotkeyManager we touch. */
interface HotkeyManagerLike {
	setHotkeys(commandId: string, hotkeys: { modifiers: string[]; key: string }[]): void;
	removeHotkeys(commandId: string): void;
}

function hotkeyManager(app: App): HotkeyManagerLike | null {
	const hm = (app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager;
	return hm && typeof hm.setHotkeys === "function" && typeof hm.removeHotkeys === "function" ? hm : null;
}

/**
 * Registers the Alt+R command and its mode-driven hotkey toggle. `onAltR` receives
 * the active drawing leaf when the key fires; omit it to only shadow Templater
 * (the command still runs, as a no-op, which is what consumes the key). Returns a
 * disposer that drops the listeners and releases the hotkey; the command itself is
 * cleaned up by Obsidian when the plugin unloads.
 */
export function attachAltRHotkey(
	plugin: ExcalidrawPureRefPlugin,
	onAltR?: (leaf: WorkspaceLeaf) => void,
): () => void {
	const app = plugin.app;
	const fullId = `${plugin.manifest.id}:${COMMAND_SUBID}`;

	plugin.addCommand({
		id: COMMAND_SUBID,
		name: "PureRef Alt+R action (drawing mode)",
		callback: () => {
			const leaf = app.workspace.getMostRecentLeaf();
			// Defensive: the hotkey is only assigned in drawing mode, but guard anyway.
			if (isExcalidrawLeaf(leaf)) onAltR?.(leaf as WorkspaceLeaf);
		},
	});

	let assigned = false;
	const sync = () => {
		const hm = hotkeyManager(app);
		if (!hm) return;
		const drawing = isExcalidrawLeaf(app.workspace.getMostRecentLeaf());
		if (drawing && !assigned) {
			try {
				hm.setHotkeys(fullId, [{ modifiers: ["Alt"], key: "r" }]);
				assigned = true;
			} catch {
				/* hotkey manager shape changed — leave Alt+R to Templater */
			}
		} else if (!drawing && assigned) {
			try {
				hm.removeHotkeys(fullId);
			} catch {
				/* ignore */
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
				/* ignore */
			}
			assigned = false;
		}
	};
}
