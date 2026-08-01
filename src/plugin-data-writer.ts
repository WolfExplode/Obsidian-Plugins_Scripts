/** The two top-level records this host plugin owns in Obsidian's data.json. */
export type PluginDataSection = "geometry" | "hotkeys";

/**
 * The Obsidian persistence seam used in production by Plugin and in tests by
 * an in-memory adapter. Keeping this structural avoids a runtime obsidian
 * import, so the serialization contract can be tested under Node.
 */
export interface PluginDataAdapter {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

function asPluginData(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Owns every read-modify-write transaction against the host plugin's
 * data.json. GeometryStore and HotkeyStore keep their domain state and expose
 * their existing interfaces; this module alone owns cross-store ordering,
 * top-level merging, and write-queue failure recovery.
 */
export class PluginDataWriter {
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly adapter: PluginDataAdapter) {}

	async readSection<T>(section: PluginDataSection): Promise<T | undefined> {
		const data = asPluginData(await this.adapter.loadData());
		return data[section] as T | undefined;
	}

	async writeSection(section: PluginDataSection, value: unknown): Promise<void> {
		const write = this.writeQueue.then(async () => {
			const current = asPluginData(await this.adapter.loadData());
			await this.adapter.saveData({ ...current, [section]: value });
		});
		// Reject this caller on failure without poisoning later queued writes.
		this.writeQueue = write.catch(() => undefined);
		await write;
	}
}
