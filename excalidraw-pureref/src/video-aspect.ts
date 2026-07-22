import type { TFile } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { localLinkpath } from "./board-render";
import { findExcalidrawLeafForNode, readSceneElements, resizeSceneElements } from "./excalidraw-view";

/**
 * Fixes the bounds of freshly-imported local media so they match the file's real
 * aspect ratio.
 *
 * WHY EXCALIDRAW GETS THIS "WRONG": a dropped video is imported as an
 * `embeddable` element, not an `image`. Excalidraw only measures intrinsic pixel
 * dimensions for images — on insert it reads `naturalWidth/naturalHeight` off the
 * decoded bitmap and sizes the element to that ratio (App.tsx). An embeddable
 * wraps an opaque iframe with no reliable intrinsic size, so instead of loading
 * the media it looks the size up in a hardcoded aspect-ratio table keyed on the
 * embed URL (element/embeddable.ts: YouTube 560×315, generic 560×840, …). A local
 * video matches no entry and lands on the generic default box, so a 16:9 clip
 * gets letterboxed inside a tall/near-square placeholder. There is no per-file
 * "fit to media" setting — only one global default embeddable size.
 *
 * THE FIX: after a media drop we watch the scene for the new embeddable(s), load
 * the real file just far enough to read `videoWidth/videoHeight` (or an image's
 * natural size for animated gif/webp embeds), and rewrite the element's box to
 * that ratio — preserving the placeholder's centre and visual area — as one
 * undoable step. We only ever touch elements that appear *after* the drop, so an
 * intentionally stretched existing element is never disturbed.
 */

/** Media extensions imported as embeddables that we can measure and re-fit. */
const MEDIA_KIND_BY_EXT: Record<string, "video" | "image"> = {
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

const extOf = (name: string): string => {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** How long a dropped video's element may take to appear before we give up. */
const POLL_INTERVAL_MS = 150;
const POLL_TIMEOUT_MS = 6000;
/** A measured ratio this close to the current one is left alone (already correct). */
const RATIO_EPSILON = 0.01;

interface EmbeddableEl {
	id?: string;
	type?: string;
	link?: string | null;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	isDeleted?: boolean;
}

/**
 * A loadable resource URL for an embeddable's linked vault file, or null if the
 * link isn't a resolvable local media file. Uses Obsidian's `getResourcePath`
 * (an `app://` URL): the main and popout renderers block `file://` for media, so
 * that scheme — used by board-render's separate transparent window — errors here.
 * Shares board-render's link parsing so the two agree on what "a local media
 * embed" is.
 */
function resolveMediaFile(
	plugin: ExcalidrawPureRefPlugin,
	link: string | null | undefined,
	boardPath: string,
): { url: string; kind: "video" | "image" } | null {
	const linkpath = localLinkpath(link);
	if (!linkpath) return null;
	const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, boardPath);
	if (!dest) return null;
	const kind = MEDIA_KIND_BY_EXT[dest.extension.toLowerCase()];
	if (!kind) return null;
	try {
		return { url: plugin.app.vault.getResourcePath(dest), kind };
	} catch {
		return null;
	}
}

/** Loads just enough of a media file to read its natural pixel dimensions. */
function probeNaturalSize(
	win: Window,
	url: string,
	kind: "video" | "image",
): Promise<{ w: number; h: number } | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: { w: number; h: number } | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = win.setTimeout(() => finish(null), 15000);

		if (kind === "video") {
			const v = win.document.createElement("video");
			v.preload = "metadata";
			v.muted = true;
			v.onloadedmetadata = () => finish(v.videoWidth > 0 && v.videoHeight > 0 ? { w: v.videoWidth, h: v.videoHeight } : null);
			v.onerror = () => finish(null);
			v.src = url;
		} else {
			const img = win.document.createElement("img");
			img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
			img.onerror = () => finish(null);
			img.src = url;
		}
	});
}

/**
 * Rewrites `el`'s box to aspect ratio `w:h`, keeping its centre fixed and its
 * area roughly constant (so the visual footprint of Excalidraw's placeholder is
 * preserved, only the shape changes). Returns null if the element already matches
 * the ratio or its current box is degenerate.
 */
function fitBox(el: EmbeddableEl, natural: { w: number; h: number }) {
	const curW = el.width ?? 0;
	const curH = el.height ?? 0;
	if (curW <= 0 || curH <= 0) return null;
	const targetRatio = natural.w / natural.h;
	if (Math.abs(curW / curH - targetRatio) <= RATIO_EPSILON * targetRatio) return null;

	const area = curW * curH;
	const newW = Math.sqrt(area * targetRatio);
	const newH = area / newW;
	const cx = (el.x ?? 0) + curW / 2;
	const cy = (el.y ?? 0) + curH / 2;
	return { id: el.id as string, x: cx - newW / 2, y: cy - newH / 2, width: newW, height: newH };
}

/**
 * Installs a document-level media aspect-ratio corrector. Attach it BEFORE the
 * drop bridge on the same document: it listens in the capture phase and only
 * reads, so it must run before the bridge's `stopImmediatePropagation` on a
 * bridged drop. Returns a detach function.
 */
export function attachVideoAspectCorrector(plugin: ExcalidrawPureRefPlugin, doc: Document): () => void {
	const win = doc.defaultView ?? window;
	// Element ids we've already fitted (or are fitting), shared across overlapping
	// drops so two near-simultaneous polls never fight over the same element.
	const handled = new Set<string>();
	let detached = false;

	const onDrop = (event: DragEvent) => {
		// Only real user drops; the bridge's re-dispatched synthetic drop isn't
		// trusted, and the element it creates is caught by the same poll anyway.
		if (!event.isTrusted) return;
		const dt = event.dataTransfer;
		if (!dt || !dt.files || dt.files.length === 0) return;
		if (!Array.from(dt.files).some((f) => MEDIA_KIND_BY_EXT[extOf(f.name)])) return;

		const target = event.target instanceof Node ? event.target : null;
		const leaf = findExcalidrawLeafForNode(plugin.app, target);
		if (!leaf) return;
		const boardPath = (leaf.view as unknown as { file?: TFile }).file?.path;
		if (!boardPath) return;

		// Embeddables already in the scene at drop time are off-limits — we only
		// fit ones the drop is about to add, so a user's manual sizing is safe.
		const preexisting = new Set<string>();
		for (const raw of readSceneElements(leaf) ?? []) {
			const el = raw as EmbeddableEl;
			if (el.type === "embeddable" && el.id) preexisting.add(el.id);
		}

		const deadline = Date.now() + POLL_TIMEOUT_MS;
		const tick = () => {
			if (detached || Date.now() > deadline) return;
			for (const raw of readSceneElements(leaf) ?? []) {
				const el = raw as EmbeddableEl;
				if (el.type !== "embeddable" || !el.id || el.isDeleted) continue;
				if (preexisting.has(el.id) || handled.has(el.id)) continue;
				const media = resolveMediaFile(plugin, el.link, boardPath);
				if (!media) continue;
				handled.add(el.id);
				const id = el.id;
				void probeNaturalSize(win, media.url, media.kind).then((natural) => {
					if (detached || !natural) return;
					// Re-read: the element may have moved/resized while we probed.
					const current = (readSceneElements(leaf) ?? []).find((e) => (e as EmbeddableEl).id === id) as
						| EmbeddableEl
						| undefined;
					if (!current) return;
					const resize = fitBox(current, natural);
					if (resize) resizeSceneElements(leaf, [resize]);
				});
			}
			win.setTimeout(tick, POLL_INTERVAL_MS);
		};
		win.setTimeout(tick, POLL_INTERVAL_MS);
	};

	doc.addEventListener("drop", onDrop, true);
	return () => {
		detached = true;
		doc.removeEventListener("drop", onDrop, true);
	};
}
