import type { ElectronBounds } from "./electron";
import type { ExcalidrawViewport } from "./excalidraw-view";
import type { PluginDataWriter } from "./plugin-data-writer";

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
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(private readonly dataWriter: PluginDataWriter) {}

	async load(): Promise<void> {
		const stored = await this.dataWriter.readSection<Partial<GeometryData>>("geometry");
		// `viewports` was added after `boards`; tolerate data.json written by an
		// older build that only has `boards`.
		this.data = {
			boards: stored?.boards ?? {},
			viewports: stored?.viewports ?? {},
		};
	}

	get(filePath: string): ElectronBounds | null {
		return this.data.boards[filePath] ?? null;
	}

	set(filePath: string, bounds: ElectronBounds): Promise<void> {
		const savedBounds = { ...bounds };
		return this.enqueueMutation((current) => ({
			boards: { ...current.boards, [filePath]: savedBounds },
			viewports: { ...current.viewports },
		}));
	}

	getViewport(filePath: string): ExcalidrawViewport | null {
		return this.data.viewports[filePath] ?? null;
	}

	setViewport(filePath: string, viewport: ExcalidrawViewport): Promise<void> {
		const savedViewport = { ...viewport };
		return this.enqueueMutation((current) => ({
			boards: { ...current.boards },
			viewports: { ...current.viewports, [filePath]: savedViewport },
		}));
	}

	clear(filePath: string): Promise<void> {
		return this.enqueueMutation((current) => {
			const boards = { ...current.boards };
			const viewports = { ...current.viewports };
			delete boards[filePath];
			delete viewports[filePath];
			return { boards, viewports };
		});
	}

	clearAll(): Promise<void> {
		return this.enqueueMutation(() => emptyData());
	}

	/** Serializes copy-on-write changes and publishes them in memory only after the save succeeds. */
	private enqueueMutation(transform: (current: GeometryData) => GeometryData): Promise<void> {
		const mutation = this.mutationQueue.then(async () => {
			const next = transform(this.data);
			await this.dataWriter.writeSection("geometry", next);
			this.data = next;
		});
		// Reject this caller on failure without preventing a later mutation from
		// starting from the last successfully persisted state.
		this.mutationQueue = mutation.catch(() => undefined);
		return mutation;
	}
}
