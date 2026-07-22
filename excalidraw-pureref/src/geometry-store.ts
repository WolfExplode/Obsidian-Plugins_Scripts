import type { Plugin } from "obsidian";
import type { ElectronBounds } from "./electron";
import type { ExcalidrawViewport } from "./excalidraw-view";

/**
 * Persists each Board's last Popout window bounds AND canvas camera (scroll +
 * zoom), keyed by vault-relative file path (per CONTEXT.md's "Popout"
 * persistence contract). Saved through Obsidian's own plugin data store
 * (data.json), not a separate file.
 *
 * Bounds are stored in absolute *physical* screen pixels (see
 * getWindowPhysicalBoundsById in electron.ts), not DIP, so geometry survives
 * being restored onto a monitor whose DPI scale differs from the one it was
 * captured on. Any geometry saved by an older DIP-based build is read as
 * physical once and self-corrects on the next save.
 *
 * The viewport is stored in Excalidraw scene units, independent of the window
 * size; on restore the window bounds are re-applied first, so the same
 * scroll/zoom reproduces the same framing. A Board with no stored viewport
 * (never popped out before) mirrors the main view on first launch instead.
 */

interface GeometryData {
	boards: Record<string, ElectronBounds>;
	viewports: Record<string, ExcalidrawViewport>;
}

const emptyData = (): GeometryData => ({ boards: {}, viewports: {} });

export class GeometryStore {
	private data: GeometryData = emptyData();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly plugin: Plugin) {}

	async load(): Promise<void> {
		const stored = (await this.plugin.loadData()) as { geometry?: Partial<GeometryData> } | null;
		// `viewports` was added after `boards`; tolerate data.json written by an
		// older build that only has `boards`.
		this.data = {
			boards: stored?.geometry?.boards ?? {},
			viewports: stored?.geometry?.viewports ?? {},
		};
	}

	get(filePath: string): ElectronBounds | null {
		return this.data.boards[filePath] ?? null;
	}

	async set(filePath: string, bounds: ElectronBounds): Promise<void> {
		this.data.boards[filePath] = bounds;
		await this.persist();
	}

	getViewport(filePath: string): ExcalidrawViewport | null {
		return this.data.viewports[filePath] ?? null;
	}

	async setViewport(filePath: string, viewport: ExcalidrawViewport): Promise<void> {
		this.data.viewports[filePath] = viewport;
		await this.persist();
	}

	async clear(filePath: string): Promise<void> {
		delete this.data.boards[filePath];
		delete this.data.viewports[filePath];
		await this.persist();
	}

	async clearAll(): Promise<void> {
		this.data = emptyData();
		await this.persist();
	}

	private async persist(): Promise<void> {
		// Capture the state associated with this call. Later mutations must not
		// change an older queued write while it is waiting for the data file.
		const snapshot: GeometryData = {
			boards: { ...this.data.boards },
			viewports: { ...this.data.viewports },
		};
		const write = this.writeQueue.then(async () => {
			const existing = ((await this.plugin.loadData()) as Record<string, unknown> | null) ?? {};
			await this.plugin.saveData({ ...existing, geometry: snapshot });
		});
		// A failed write rejects its caller but cannot poison every future write.
		this.writeQueue = write.catch(() => undefined);
		await write;
	}
}
