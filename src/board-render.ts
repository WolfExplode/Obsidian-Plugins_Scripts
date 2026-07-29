import type { TFile } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import type { MediaOverlay } from "./transparent-proto";

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

/**
 * Excalidraw file extensions we can play/animate as a live HTML overlay. Local
 * video and animated images are embedded as "embeddable" elements whose static
 * SVG export is empty (see MediaOverlay), so the read-only window renders these
 * with a real <video>/<img>. Regular still images (png/jpg) are NOT here: they
 * export fine as inline <image>, so they need no overlay.
 */
const OVERLAY_KIND_BY_EXT: Record<string, "video" | "image"> = {
	mp4: "video",
	webm: "video",
	mov: "video",
	m4v: "video",
	ogv: "video",
	mkv: "video",
	gif: "image",
	apng: "image",
	webp: "image",
};

interface EmbeddableLike {
	type?: string;
	link?: string | null;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	angle?: number;
	isDeleted?: boolean;
}

/**
 * The vault-file linkpath an embeddable points at, or null if it's not a local
 * file link (e.g. an `https://` website embed, which the SVG's own iframe
 * already handles). Handles Obsidian's `[[wikilink|alias#heading]]` form.
 */
export function localLinkpath(link: string | null | undefined): string | null {
	if (!link) return null;
	let s = link.trim();
	if (/^[a-z]+:\/\//i.test(s)) return null; // http(s)/app/etc — not a vault file
	const wiki = s.match(/^\[\[([^\]]+)\]\]$/);
	if (wiki) s = wiki[1];
	s = s.split("|")[0].split("#")[0].trim();
	return s || null;
}

function nodeRequire(): ((id: string) => unknown) | null {
	return (window as Window & { require?: (id: string) => unknown }).require ?? null;
}

/**
 * Live-media overlays for `elements`: every embeddable whose link resolves to a
 * local video / animated-image file, expressed in scene coordinates so the
 * read-only window can place a real <video>/<img> exactly where the (empty)
 * exported element sits. `boardPath` is the source for link resolution. Website
 * embeds and unresolvable links are skipped.
 */
export function collectMediaOverlays(
	plugin: ExcalidrawPureRefPlugin,
	elements: readonly unknown[],
	boardPath: string,
): MediaOverlay[] {
	const req = nodeRequire();
	const adapter = plugin.app.vault.adapter as unknown as { getBasePath?(): string };
	const basePath = adapter.getBasePath?.();
	if (!req || !basePath) return [];
	let path: { join(...parts: string[]): string };
	let url: { pathToFileURL(p: string): { href: string } };
	try {
		path = req("path") as typeof path;
		url = req("url") as typeof url;
	} catch {
		return [];
	}

	const overlays: MediaOverlay[] = [];
	let skipped = 0;
	for (const raw of elements) {
		const el = raw as EmbeddableLike;
		if (el.isDeleted || el.type !== "embeddable") continue;
		const linkpath = localLinkpath(el.link);
		if (!linkpath) continue; // website embed or no link
		const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, boardPath);
		if (!dest) {
			skipped++;
			continue;
		}
		const kind = OVERLAY_KIND_BY_EXT[dest.extension.toLowerCase()];
		if (!kind) continue; // linked file isn't a media type we overlay
		try {
			const src = url.pathToFileURL(path.join(basePath, dest.path)).href;
			overlays.push({
				kind,
				src,
				x: el.x ?? 0,
				y: el.y ?? 0,
				width: el.width ?? 0,
				height: el.height ?? 0,
				angle: el.angle ?? 0,
			});
		} catch (error) {
			console.error("[Excalidraw PureRef] media overlay URL failed for", dest.path, error);
		}
	}
	if (overlays.length || skipped) {
		console.debug(
			`[Excalidraw PureRef] media overlays: ${overlays.length} rendered` +
				(skipped ? `, ${skipped} unresolved link(s) skipped` : ""),
		);
	}
	return overlays;
}

/**
 * Extensions this plugin will snapshot into a static image overlay by
 * instantiating whatever component another plugin registered for that
 * extension via `app.embedRegistry` (e.g. obsidian-extended-file-support's
 * KRA/PUR/TIFF/HDR/... renderers). Excalidraw's own SVG export can't rasterize
 * these embeddables (same reason as video/gif above), so without this they
 * show as Excalidraw's plain placeholder link box in F10 mode.
 *
 * Deliberately an allowlist, not "any registered extension": these all
 * resolve their `loadFile()` (plus, for image-tag-based ones, a `load` event)
 * as a genuine one-shot completion signal — verified live against
 * obsidian-extended-file-support. 3D formats (obj/fbx/glb/gltf/stl) render on
 * a perpetual animation loop with no signal for "the model has loaded" at
 * all, so they are left out and stay as Excalidraw's placeholder box.
 */
const SNAPSHOT_EXTENSIONS = new Set([
	"tiff", "tif", "dds", "hdr", "exr", "tga", "psd", "ai", "jfif", "kra", "pur", "clip",
]);

/**
 * Circuit breaker, not a timing heuristic: every extension in
 * SNAPSHOT_EXTENSIONS resolves in well under a second in practice. This only
 * stops a hung or broken embed (a future upstream regression, a corrupt file)
 * from blocking the whole read-only render indefinitely.
 */
const SNAPSHOT_TIMEOUT_MS = 15000;

interface EmbedContextLike {
	app: unknown;
	containerEl: HTMLElement;
}

interface EmbedComponentLike {
	scene?: unknown;
	load?(): void;
	unload?(): void;
	loadFile?(): Promise<void>;
}

type EmbedCreatorLike = (context: EmbedContextLike, file: TFile, subpath?: string) => EmbedComponentLike;

interface EmbedRegistryLike {
	getEmbedCreator?(file: TFile): EmbedCreatorLike | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = window.setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(null);
			}
		}, ms);
		promise.then(
			(value) => {
				if (!settled) {
					settled = true;
					window.clearTimeout(timer);
					resolve(value);
				}
			},
			() => {
				if (!settled) {
					settled = true;
					window.clearTimeout(timer);
					resolve(null);
				}
			},
		);
	});
}

interface SnapshotCacheEntry {
	mtime: number;
	size: number;
	dataURL: string;
}

/**
 * Keyed by vault path. The underlying decoders (three.js loaders, pdf.js,
 * webtoon/psd) run synchronously on the main thread, so redoing them on every
 * F10 toggle is real, felt jank — not just wasted work. mtime+size catches an
 * edit to the source file without needing a vault "modify" subscription.
 */
const snapshotCache = new Map<string, SnapshotCacheEntry>();

/**
 * Renders one snapshot-able embeddable's linked file into a `data:` URL PNG,
 * by instantiating whatever component the owning plugin registered for its
 * extension in a detached, off-screen container, then rasterizing whatever it
 * painted. Runs in the main Obsidian window, where that plugin's own decode
 * workers / three.js / pdf.js infrastructure already lives — only the
 * resulting raster crosses into the transparent read-only window.
 */
async function snapshotEmbeddableFile(plugin: ExcalidrawPureRefPlugin, file: TFile): Promise<string | null> {
	const cached = snapshotCache.get(file.path);
	if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
		return cached.dataURL;
	}

	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistryLike }).embedRegistry;
	const creator = registry?.getEmbedCreator?.(file);
	if (!creator) return null;

	const container = document.body.createDiv();
	container.setCssStyles({ position: "fixed", left: "-99999px", top: "-99999px", pointerEvents: "none" });

	let embed: EmbedComponentLike | null = null;
	try {
		embed = creator({ app: plugin.app, containerEl: container }, file);
		embed.load?.();
		const ready = embed.loadFile ? embed.loadFile() : Promise.resolve();
		const outcome = await withTimeout(ready, SNAPSHOT_TIMEOUT_MS);
		if (outcome === null) {
			console.error(`[Excalidraw PureRef] snapshot timed out for ${file.path}.`);
			return null;
		}

		let dataURL: string | null = null;
		const canvas = container.querySelector("canvas");
		if (canvas) {
			dataURL = canvas.toDataURL("image/png");
		} else {
			const img = container.querySelector("img");
			if (img && img.complete && img.naturalWidth > 0) {
				const out = document.createElement("canvas");
				out.width = img.naturalWidth;
				out.height = img.naturalHeight;
				out.getContext("2d")?.drawImage(img, 0, 0);
				dataURL = out.toDataURL("image/png");
			}
		}

		if (dataURL) snapshotCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, dataURL });
		return dataURL;
	} catch (error) {
		console.error(`[Excalidraw PureRef] snapshot failed for ${file.path}.`, error);
		return null;
	} finally {
		embed?.unload?.();
		container.remove();
	}
}

/**
 * Snapshot-based overlays for `elements`: every embeddable whose link resolves
 * to a local file in SNAPSHOT_EXTENSIONS, expressed in scene coordinates like
 * collectMediaOverlays. Unlike that function these aren't live — the file is
 * rendered once, right now, into a static raster.
 */
export async function collectExtensionOverlays(
	plugin: ExcalidrawPureRefPlugin,
	elements: readonly unknown[],
	boardPath: string,
): Promise<MediaOverlay[]> {
	const overlays: MediaOverlay[] = [];
	const tasks: Promise<void>[] = [];

	for (const raw of elements) {
		const el = raw as EmbeddableLike;
		if (el.isDeleted || el.type !== "embeddable") continue;
		const linkpath = localLinkpath(el.link);
		if (!linkpath) continue;
		const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, boardPath);
		if (!dest) continue;
		const ext = dest.extension.toLowerCase();
		if (OVERLAY_KIND_BY_EXT[ext]) continue; // already handled live as video/gif
		if (!SNAPSHOT_EXTENSIONS.has(ext)) continue;

		const x = el.x ?? 0;
		const y = el.y ?? 0;
		const width = el.width ?? 0;
		const height = el.height ?? 0;
		const angle = el.angle ?? 0;
		tasks.push(
			snapshotEmbeddableFile(plugin, dest).then((src) => {
				if (src) overlays.push({ kind: "image", src, x, y, width, height, angle });
			}),
		);
	}

	await Promise.all(tasks);
	return overlays;
}

let renderQueue: Promise<void> = Promise.resolve();

async function renderBoardSvgNow(
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
		//
		// Keep Excalidraw's theme conversion enabled: ordinary scene elements rely
		// on it to render with the same light/dark appearance as the editable
		// canvas. The theme must be explicit, however. If it is omitted,
		// Excalidraw can default the standalone read-only export to light mode,
		// which makes the exported scene and web embeds disagree.
		const isDark = document.body.classList.contains("theme-dark");
		const exportSettings = ea.getExportSettings?.(false, true);
		const svg = await ea.createSVG(filePath, true, exportSettings, undefined, isDark ? "dark" : "light", 0);
		// Excalidraw adds its dark-mode inversion filter to foreignObject nodes.
		// Those nodes contain live web embeds, whose pixels already come from the
		// embedded page in its intended colors. Applying the SVG filter a second
		// time is why videos/iframes invert while normal SVG elements remain correct.
		svg.querySelectorAll("foreignObject").forEach((node) => {
			node.removeAttribute("filter");
		});
		return svg?.outerHTML ?? null;
	} catch (error) {
		console.error("[Excalidraw PureRef] createSVG failed for", filePath, error);
		return null;
	}
}

/**
 * Full-fidelity transparent SVG of `filePath`, serialized because the
 * ExcalidrawAutomate renderer carries mutable reset/createSVG working state.
 */
export function renderBoardSvg(
	plugin: ExcalidrawPureRefPlugin,
	filePath: string,
): Promise<string | null> {
	const render = renderQueue.then(() => renderBoardSvgNow(plugin, filePath));
	renderQueue = render.then(
		() => undefined,
		() => undefined,
	);
	return render;
}
