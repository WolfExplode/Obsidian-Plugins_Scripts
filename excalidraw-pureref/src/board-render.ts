import type ExcalidrawPureRefPlugin from "../main";

/**
 * Renders a Board file to a standalone, background-less SVG string, using the
 * installed Excalidraw community plugin's own public renderer
 * (ExcalidrawAutomate.createSVG). This runs in Obsidian's renderer — where that
 * plugin lives — and the resulting SVG string is shipped to the transparent
 * read-only window, which just displays it. Per ADR 0001 we depend only on the
 * Excalidraw plugin's public runtime API, never its source.
 *
 * createSVG(filePath) is the reliable path: it loads the scene, resolves
 * embedded images, honours cropping/freedraw/shapes, and instantiates loaders
 * itself. `withBackground: false` is what keeps the export transparent, so the
 * desktop shows through everywhere the drawing doesn't paint.
 */

interface ExportSettingsLike {
	withBackground: boolean;
	withTheme: boolean;
}

interface BoundingBoxLike {
	topX: number;
	topY: number;
	width: number;
	height: number;
}

interface ExcalidrawAutomateLike {
	getAPI?(view?: unknown): ExcalidrawAutomateLike;
	reset?(): void;
	getExportSettings?(withBackground: boolean, withTheme: boolean, isMask?: boolean): ExportSettingsLike;
	getBoundingBox?(elements: readonly unknown[]): BoundingBoxLike;
	createSVG(
		templatePath?: string,
		embedFont?: boolean,
		exportSettings?: ExportSettingsLike,
		loader?: unknown,
		theme?: string,
		padding?: number,
	): Promise<SVGSVGElement>;
}

function getExcalidrawAutomate(plugin: ExcalidrawPureRefPlugin): ExcalidrawAutomateLike | null {
	const fromWindow = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateLike }).ExcalidrawAutomate;
	if (fromWindow) return fromWindow;
	const excalidrawPlugin = (
		plugin.app as unknown as {
			plugins?: { plugins?: Record<string, { ea?: ExcalidrawAutomateLike }> };
		}
	).plugins?.plugins?.["obsidian-excalidraw-plugin"];
	return excalidrawPlugin?.ea ?? null;
}

/**
 * The scene coordinate that maps to the exported SVG's local (0,0): the top-left
 * of the elements' common bounding box. The SVG normalizes content to start at
 * (0,0) and records no absolute position, so this must come from the elements.
 * `ea.getBoundingBox` uses the same bounds math the exporter does, so its
 * top-left matches the SVG exactly. Returns null if unavailable.
 */
export function getSceneMin(
	plugin: ExcalidrawPureRefPlugin,
	elements: readonly unknown[],
): { minX: number; minY: number } | null {
	const base = getExcalidrawAutomate(plugin);
	if (!base || elements.length === 0) return null;
	try {
		let ea = base;
		try {
			if (typeof base.getAPI === "function") ea = base.getAPI();
		} catch {
			ea = base;
		}
		const bb = ea.getBoundingBox?.(elements);
		if (!bb) return null;
		return { minX: bb.topX, minY: bb.topY };
	} catch (error) {
		console.error("[Excalidraw PureRef] getBoundingBox failed.", error);
		return null;
	}
}

/** Full-fidelity, transparent SVG of `filePath` as a string, or null on failure. */
export async function renderBoardSvg(
	plugin: ExcalidrawPureRefPlugin,
	filePath: string,
): Promise<string | null> {
	const base = getExcalidrawAutomate(plugin);
	if (!base) {
		console.error("[Excalidraw PureRef] ExcalidrawAutomate is unavailable — is the Excalidraw plugin enabled?");
		return null;
	}
	try {
		// An isolated instance so we never clobber the shared automate state.
		let ea = base;
		try {
			if (typeof base.getAPI === "function") ea = base.getAPI();
		} catch {
			ea = base;
		}
		try {
			ea.reset?.();
		} catch {
			/* best-effort */
		}
		// withBackground: false -> no background rect -> stays see-through.
		const exportSettings = ea.getExportSettings?.(false, true);
		const svg = await ea.createSVG(filePath, true, exportSettings, undefined, undefined, 0);
		return svg?.outerHTML ?? null;
	} catch (error) {
		console.error("[Excalidraw PureRef] createSVG failed for", filePath, error);
		return null;
	}
}
