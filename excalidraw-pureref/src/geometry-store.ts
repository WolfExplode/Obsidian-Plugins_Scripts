import type { Plugin } from "obsidian";
import type { ElectronBounds } from "./electron";

/**
 * Persists each Board's last Popout window bounds, keyed by vault-relative
 * file path (per CONTEXT.md's "Popout" geometry-persistence contract).
 * Saved through Obsidian's own plugin data store (data.json), not a separate file.
 *
 * Bounds are stored in absolute *physical* screen pixels (see
 * getWindowPhysicalBoundsById in electron.ts), not DIP, so geometry survives
 * being restored onto a monitor whose DPI scale differs from the one it was
 * captured on. Any geometry saved by an older DIP-based build is read as
 * physical once and self-corrects on the next save.
 */

interface GeometryData {
	boards: Record<string, ElectronBounds>;
}

const DEFAULT_DATA: GeometryData = { boards: {} };

export class GeometryStore {
	private data: GeometryData = { boards: {} };

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		const stored = (await this.plugin.loadData()) as { geometry?: GeometryData } | null;
		this.data = stored?.geometry ?? { ...DEFAULT_DATA, boards: {} };
	}

	get(filePath: string): ElectronBounds | null {
		return this.data.boards[filePath] ?? null;
	}

	async set(filePath: string, bounds: ElectronBounds): Promise<void> {
		this.data.boards[filePath] = bounds;
		await this.persist();
	}

	async clear(filePath: string): Promise<void> {
		delete this.data.boards[filePath];
		await this.persist();
	}

	async clearAll(): Promise<void> {
		this.data = { boards: {} };
		await this.persist();
	}

	private async persist(): Promise<void> {
		const existing = ((await this.plugin.loadData()) as Record<string, unknown> | null) ?? {};
		await this.plugin.saveData({ ...existing, geometry: this.data });
	}
}
