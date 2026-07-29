import type { App } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { HOTKEY_ACTIONS } from "./hotkey-registry";
import type { HotkeyStore } from "./hotkey-store";

/**
 * The minimal slice of Obsidian's (untyped) HotkeyManager this plugin touches
 * — same shape alt-r.ts already relies on for its context-driven Alt+R
 * shadowing. `setHotkeys` overwrites the custom-keys store for a command
 * (baked first, ahead of any built-in default) without touching hotkeys.json
 * until the user separately edits Settings → Hotkeys.
 */
interface HotkeyManagerLike {
	setHotkeys(commandId: string, hotkeys: { modifiers: string[]; key: string }[]): void;
}

export function hotkeyManager(app: App): HotkeyManagerLike | null {
	const hm = (app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager;
	return hm && typeof hm.setHotkeys === "function" ? hm : null;
}

/**
 * Pushes every registry action backed by a real Obsidian command (toggle
 * popout/readonly, opacity ±, export) into Obsidian's hotkeyManager, so the
 * plugin's own settings UI is the single source of truth for their bindings
 * instead of Settings → Hotkeys. Safe to call repeatedly (on load and on
 * every HotkeyStore change); a HotkeyManager shape change is swallowed so a
 * future Obsidian API change degrades to "keeps last-baked binding" rather
 * than throwing.
 */
export function syncObsidianHotkeys(plugin: ExcalidrawPureRefPlugin, store: HotkeyStore): void {
	const hm = hotkeyManager(plugin.app);
	if (!hm) return;
	for (const action of HOTKEY_ACTIONS) {
		if (!action.commandId) continue;
		const fullId = `${plugin.manifest.id}:${action.commandId}`;
		const bindings = store.get(action.id)
			.filter((binding) => binding.key !== null)
			.map((binding) => ({ modifiers: binding.modifiers as string[], key: binding.key as string }));
		try {
			hm.setHotkeys(fullId, bindings);
		} catch {
			/* hotkey manager shape changed — leave the command's baked-in default */
		}
	}
}
