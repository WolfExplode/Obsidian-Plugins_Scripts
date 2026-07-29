import type { Plugin } from "obsidian";
import { getHotkeyAction, HOTKEY_ACTIONS, type HotkeyBinding } from "./hotkey-registry";

/**
 * Persists user overrides of the plugin's hotkey bindings (see
 * hotkey-registry.ts for the fixed action list), keyed by action id. Modeled
 * on GeometryStore (geometry-store.ts): same load-once / read-modify-write-
 * merge-under-one-top-level-key pattern against Obsidian's own data.json, so
 * this store and GeometryStore can coexist without clobbering each other's
 * key. An action with no override falls back to its registry default.
 */
export class HotkeyStore {
	private overrides: Record<string, HotkeyBinding[]> = {};
	private writeQueue: Promise<void> = Promise.resolve();
	private listeners: Set<() => void> = new Set();

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		const stored = (await this.plugin.loadData()) as { hotkeys?: Record<string, HotkeyBinding[]> } | null;
		this.overrides = { ...(stored?.hotkeys ?? {}) };
	}

	/** Current bindings for an action: its override if set, else its registry default. */
	get(actionId: string): HotkeyBinding[] {
		return this.overrides[actionId] ?? getHotkeyAction(actionId)?.default ?? [];
	}

	isOverridden(actionId: string): boolean {
		return actionId in this.overrides;
	}

	async set(actionId: string, bindings: HotkeyBinding[]): Promise<void> {
		this.overrides[actionId] = bindings;
		await this.persist();
		this.notify();
	}

	async reset(actionId: string): Promise<void> {
		delete this.overrides[actionId];
		await this.persist();
		this.notify();
	}

	/** All action ids whose current binding collides with another action's, grouped by binding signature. */
	findConflicts(): Map<string, string[]> {
		const bySignature = new Map<string, string[]>();
		for (const action of HOTKEY_ACTIONS) {
			for (const binding of this.get(action.id)) {
				const signature = `${action.kind === "modifier" ? "mod" : "key"}:${[...binding.modifiers].sort().join("+")}:${action.kind === "modifier" ? "" : binding.key}`;
				const ids = bySignature.get(signature) ?? [];
				ids.push(action.id);
				bySignature.set(signature, ids);
			}
		}
		for (const [signature, ids] of bySignature) {
			if (new Set(ids).size < 2) bySignature.delete(signature);
		}
		return bySignature;
	}

	/** Notified after every persisted change, so live listeners (Obsidian command sync) can re-apply bindings. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private async persist(): Promise<void> {
		const snapshot: Record<string, HotkeyBinding[]> = { ...this.overrides };
		const write = this.writeQueue.then(async () => {
			const existing = ((await this.plugin.loadData()) as Record<string, unknown> | null) ?? {};
			await this.plugin.saveData({ ...existing, hotkeys: snapshot });
		});
		this.writeQueue = write.catch(() => undefined);
		await write;
	}
}
