import type { App } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { HOTKEY_ACTIONS } from "./hotkey-registry";
import type { HotkeyStore } from "./hotkey-store";

/**
 * The minimal slice of Obsidian's (untyped) HotkeyManager this plugin touches
 * — same shape rotation-reset-hotkey.ts relies on for its Board-scoped Alt+R
 * shadowing. `setHotkeys` overwrites the custom-keys store for a command
 * (baked first, ahead of any built-in default) without touching hotkeys.json
 * until the user separately edits Settings → Hotkeys. `bakedHotkeys`/`bakedIds`
 * are parallel arrays — the same flattened view of every active hotkey (core +
 * every installed plugin) that Settings → Hotkeys itself reads to flag
 * conflicts; `bake()` recomputes them after a `setHotkeys` call invalidates them.
 *
 * Undocumented Obsidian-core internal — not present in any vendored
 * reference/ source, so there's nothing local to grep against. Confirmed
 * live instead: connected to a running Obsidian 1.13.4 via the Obsidian
 * DevTools MCP (CDP renderer eval, `obsidian_execute_js`) and checked
 * `app.hotkeyManager`'s prototype and own-properties directly —
 * `setHotkeys`/`bake` are real prototype methods, `bakedHotkeys`/`bakedIds`
 * are real instance fields. Re-verify the same way after an Obsidian
 * upgrade if this is ever in doubt again.
 */
interface HotkeyManagerLike {
	setHotkeys(commandId: string, hotkeys: { modifiers: string[]; key: string }[]): void;
	bake?(): void;
	bakedHotkeys?: { modifiers: string; key: string }[];
	bakedIds?: string[];
}

export function hotkeyManager(app: App): HotkeyManagerLike | null {
	const hm = (app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager;
	return hm && typeof hm.setHotkeys === "function" ? hm : null;
}

export interface BakedHotkey {
	id: string;
	modifiers: string;
	key: string;
}

/**
 * Every hotkey Obsidian's keymap currently considers active, across core and
 * every installed plugin (used by settings-tab.ts to warn when a recorded
 * binding is already claimed elsewhere). Returns `[]` if the private API has
 * changed shape rather than throwing.
 */
export function getBakedHotkeys(app: App): BakedHotkey[] {
	const hm = hotkeyManager(app);
	if (!hm) return [];
	try {
		hm.bake?.();
	} catch {
		/* fall through with whatever was already baked */
	}
	const hotkeys = hm.bakedHotkeys;
	const ids = hm.bakedIds;
	if (!Array.isArray(hotkeys) || !Array.isArray(ids) || hotkeys.length !== ids.length) return [];
	return hotkeys.map((hotkey, index) => ({ id: ids[index], modifiers: hotkey.modifiers, key: hotkey.key }));
}

/** Display name for a command id, e.g. for a conflict warning. Falls back to the id if the command is unknown. */
export function getCommandName(app: App, id: string): string {
	const commands = (app as unknown as { commands?: { commands?: Record<string, { name?: string }> } }).commands?.commands;
	return commands?.[id]?.name ?? id;
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
			.filter((binding): binding is typeof binding & { key: string } => binding.key !== null)
			.map((binding) => ({ modifiers: binding.modifiers, key: binding.key }));
		try {
			hm.setHotkeys(fullId, bindings);
		} catch {
			/* hotkey manager shape changed — leave the command's baked-in default */
		}
	}
}
