import { getHotkeyAction, HOTKEY_ACTIONS, type HotkeyBinding } from "./hotkey-registry";
import type { PluginDataWriter } from "./plugin-data-writer";

/**
 * Persists user overrides of the plugin's hotkey bindings (see
 * hotkey-registry.ts for the fixed action list), keyed by action id. Modeled
 * on GeometryStore (geometry-store.ts): both keep their domain state but route
 * persistence through one PluginDataWriter, so concurrent changes cannot
 * clobber each other's top-level data.json record. An action with no override
 * falls back to its registry default.
 */
export class HotkeyStore {
	private overrides: Record<string, HotkeyBinding[]> = {};
	private listeners: Set<() => void> = new Set();

	constructor(private readonly dataWriter: PluginDataWriter) {}

	async load(): Promise<void> {
		const stored = await this.dataWriter.readSection<Record<string, HotkeyBinding[]>>("hotkeys");
		this.overrides = { ...(stored ?? {}) };
	}

	/** Current bindings for an action: its override if set, else its registry default. */
	get(actionId: string): HotkeyBinding[] {
		return this.overrides[actionId] ?? getHotkeyAction(actionId)?.default ?? [];
	}

	isOverridden(actionId: string): boolean {
		return actionId in this.overrides;
	}

	async set(actionId: string, bindings: HotkeyBinding[]): Promise<void> {
		const savedBindings = bindings.map((binding) => ({
			modifiers: [...binding.modifiers],
			key: binding.key,
		}));
		await this.persistMutation((current) => ({ ...current, [actionId]: savedBindings }));
		this.notify();
	}

	async reset(actionId: string): Promise<void> {
		await this.persistMutation((current) => {
			const next = { ...current };
			delete next[actionId];
			return next;
		});
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

	/** Publishes copy-on-write state in memory only after the atomic save succeeds. */
	private async persistMutation(
		transform: (current: Record<string, HotkeyBinding[]>) => Record<string, HotkeyBinding[]>,
	): Promise<void> {
		this.overrides = await this.dataWriter.mutateSection<Record<string, HotkeyBinding[]>>(
			"hotkeys",
			(stored) => transform(stored ?? {}),
		);
	}
}
