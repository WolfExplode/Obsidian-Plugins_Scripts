import { Platform, type App } from "obsidian";
import type { HotkeyBinding } from "./hotkey-registry";
import { getBakedHotkeys, getCommandName } from "./hotkey-sync";

export interface GlobalConflict {
	id: string;
	name: string;
}

function resolvedModifiers(modifiers: readonly string[]): Set<string> {
	const resolved = new Set<string>();
	for (const modifier of modifiers) resolved.add(modifier === "Mod" ? (Platform.isMacOS ? "Meta" : "Ctrl") : modifier);
	return resolved;
}

/**
 * Whether `binding` (a "key"-kind action's binding) is already claimed by a
 * core/other-plugin command, checked against Obsidian's own baked hotkey
 * table (hotkey-sync.ts's getBakedHotkeys) — the same data Settings → Hotkeys
 * itself reads to flag conflicts there. "modifier"-kind bindings (key: null)
 * have no Obsidian-hotkey equivalent, so they're never checked. This plugin's
 * own commands are excluded — binding to your own action isn't a conflict.
 */
export function findGlobalConflicts(app: App, pluginId: string, binding: HotkeyBinding): GlobalConflict[] {
	if (binding.key === null) return [];
	const wanted = resolvedModifiers(binding.modifiers);
	const key = binding.key.toLowerCase();
	const conflicts: GlobalConflict[] = [];
	for (const baked of getBakedHotkeys(app)) {
		if (baked.id.startsWith(`${pluginId}:`)) continue;
		if (baked.key.toLowerCase() !== key) continue;
		const bakedModifiers = baked.modifiers ? baked.modifiers.split(",") : [];
		if (bakedModifiers.length !== wanted.size || !bakedModifiers.every((modifier) => wanted.has(modifier))) continue;
		conflicts.push({ id: baked.id, name: getCommandName(app, baked.id) });
	}
	return conflicts;
}
