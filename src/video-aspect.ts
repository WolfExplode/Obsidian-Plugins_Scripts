import type { TFile, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { localLinkpath } from "./board-render";
import { isExcalidrawLeaf, readSceneElements, resizeSceneElements } from "./excalidraw-view";
import {
	attachPerLeafScanner,
	getLeafScannerApi,
	leafWindowLabel,
	type LeafScannerApi,
	type LeafScannerHandle,
} from "./leaf-scanner";

/**
 * Fixes the bounds of freshly-inserted local media so they match the file's real
 * aspect ratio.
 *
 * WHY EXCALIDRAW GETS THIS "WRONG": a video is inserted as an `embeddable`
 * element, not an `image`. Excalidraw only measures intrinsic pixel dimensions
 * for images — on insert it reads `naturalWidth/naturalHeight` off the decoded
 * bitmap and sizes the element to that ratio (App.tsx). An embeddable wraps an
 * opaque iframe with no reliable intrinsic size, so instead of loading the media
 * it looks the size up in a hardcoded aspect-ratio table keyed on the embed URL
 * (element/embeddable.ts: YouTube 560×315, generic 560×840, …). A local video
 * matches no entry and lands on the generic default box (the Obsidian plugin uses
 * a 500×500 square), so a 16:9 clip gets letterboxed. There is no per-file "fit
 * to media" setting — only one global default embeddable size.
 *
 * THE FIX: we subscribe to each Excalidraw view's `onChange` (see leaf-scanner.ts
 * for that shared lifecycle) and, the first time an embeddable linking to a local
 * media file appears, load the file just far enough to read `videoWidth/
 * videoHeight` (or an image's natural size for animated gif/webp embeds) and
 * rewrite the element's box to that ratio — preserving the placeholder's centre
 * and visual area — as one undoable step.
 *
 * Elements already present when we subscribe are seeded as "seen" and never
 * touched, so a video you deliberately stretched is left alone.
 *
 * TRACKING IS BY ELEMENT ID: each new insertion needs fitting, even if it
 * points at a file already present on this board. This includes the “Use the
 * file already in the Vault” choice. File-path tracking wrongly treated that
 * valid insertion as a copy and left its 500×500 placeholder untouched. Only
 * element IDs present as the board loaded are protected as pre-existing work.
 */

/** Media extensions inserted as embeddables that we can measure and re-fit. */
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
 * Debug tooling, off by default. Toggle at runtime (incl. via the Obsidian
 * DevTools MCP) with `window.__eprAspectDebug.setVerbose(true)`; introspect with
 * `.state()` / `.leaves()`; force a re-scan with `.reconcile()`. Kept in the
 * shipped build because this corrector spans main + popout realms, where the only
 * practical way to see what attached and fired is a live console.
 */
const DEBUG_HOOK = "__eprAspectDebug";
let verbose = false;
function dbg(...args: unknown[]): void {
	if (verbose) console.debug("[EPR aspect]", ...args);
}

/**
 * Reads embeddable ids straight out of the file's *parsed, on-disk* scene —
 * `view.excalidrawData.scene` — independent of whatever the live imperative API
 * currently holds.
 *
 * This must be captured once, after `justLoaded` clears. Although it begins as
 * the parsed on-disk scene, Excalidraw updates `excalidrawData.scene` again as
 * it synchronizes new canvas changes. Reading it during every `onChange` scan
 * would therefore turn an element inserted by the just-confirmed modal action
 * into an apparent pre-existing element before the corrector sees it.
 */
function getPersistedEmbeddableSeed(leaf: WorkspaceLeaf): Set<string> | null {
	const scene = (leaf.view as unknown as { excalidrawData?: { scene?: { elements?: readonly EmbeddableEl[] } } })
		.excalidrawData?.scene;
	const elements = scene?.elements;
	if (!elements) return null;
	const ids = new Set<string>();
	for (const el of elements) {
		if (el?.type !== "embeddable" || !el.id) continue;
		ids.add(el.id);
	}
	return ids;
}

/** Loads just enough of a media file to read its natural pixel dimensions. */
function probeNaturalSize(win: Window, url: string, kind: "video" | "image"): Promise<{ w: number; h: number } | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: { w: number; h: number } | null) => {
			if (settled) return;
			settled = true;
			win.clearTimeout(timer);
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

/** Per-view correction state. */
interface AspectState {
	/** Embeddable ids already fitted, seeded, or determined non-media. */
	seen: Set<string>;
	/** Media embeddables currently being probed (avoid double work). */
	inflight: Set<string>;
	/** Immutable snapshot of media present in the board when this listener attached. */
	persisted: Set<string> | null;
}

/**
 * Installs the media aspect-ratio corrector across every Excalidraw view — main
 * window and popouts alike. Returns a dispose function.
 */
export function attachVideoAspectCorrector(plugin: ExcalidrawPureRefPlugin): () => void {
	const setup = (leaf: WorkspaceLeaf, api: LeafScannerApi): AspectState | null => {
		const seen = new Set<string>();
		// Seed with whatever's already on the canvas so pre-existing media (which
		// the user may have sized on purpose) is never touched — only new inserts.
		try {
			for (const el of api.getSceneElements()) {
				if (el.type === "embeddable" && el.id) seen.add(el.id);
			}
		} catch (err) {
			dbg(leafWindowLabel(leaf), "seed getSceneElements threw", err);
			return null;
		}
		// Also seed from the parsed on-disk scene — see getPersistedEmbeddableSeed's
		// doc comment for why the live canvas alone isn't a reliable snapshot.
		const boardPath = (leaf.view as unknown as { file?: TFile }).file?.path;
		const persisted = boardPath ? getPersistedEmbeddableSeed(leaf) : null;
		if (persisted) {
			for (const id of persisted) seen.add(id);
		}
		dbg("attached to", leafWindowLabel(leaf), "leaf", boardPath, "seeded", seen.size);
		return { seen, inflight: new Set<string>(), persisted };
	};

	const scan = (leaf: WorkspaceLeaf, state: AspectState, scanner: LeafScannerHandle<AspectState>) => {
		const boardPath = (leaf.view as unknown as { file?: TFile }).file?.path;
		if (!boardPath) return;
		const win = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument?.defaultView ?? window;
		const winLabel = leafWindowLabel(leaf);
		const { seen, inflight, persisted } = state;

		for (const raw of readSceneElements(leaf) ?? []) {
			const el = raw as EmbeddableEl;
			if (el.type !== "embeddable" || !el.id || el.isDeleted) continue;
			const id = el.id;
			if (seen.has(id) || inflight.has(id)) continue;

			const linkpath = localLinkpath(el.link);
			if (!linkpath) {
				seen.add(id); // external URL (youtube/website) or no link — never local media
				continue;
			}
			const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkpath, boardPath);

			if (persisted?.has(id)) {
				// Present in the saved file — pre-existing, not an import.
				seen.add(id);
				continue;
			}

			if (!dest) continue; // file may still be writing; leave unseen to retry on next change
			const kind = MEDIA_KIND_BY_EXT[dest.extension.toLowerCase()];
			if (!kind) {
				seen.add(id); // a non-media embed (PDF, etc.)
				continue;
			}

			inflight.add(id);
			let url: string;
			try {
				url = plugin.app.vault.getResourcePath(dest);
			} catch {
				inflight.delete(id);
				seen.add(id);
				continue;
			}
			dbg(winLabel, "probing new media embed", id, kind);
			void probeNaturalSize(win, url, kind).then((natural) => {
				inflight.delete(id);
				seen.add(id);
				if (scanner.isDisposed() || !natural) {
					dbg(winLabel, "probe failed", id, natural);
					return;
				}
				// Re-read: the element may have moved/resized while we probed.
				const current = (readSceneElements(leaf) ?? []).find((e) => (e as EmbeddableEl).id === id) as
					| EmbeddableEl
					| undefined;
				if (!current) return;
				const resize = fitBox(current, natural);
				dbg(winLabel, "resize", id, natural, resize ? `-> ${Math.round(resize.width)}x${Math.round(resize.height)}` : "already correct");
				if (resize) resizeSceneElements(leaf, [resize]);
			});
		}
	};

	return attachPerLeafScanner<AspectState>(plugin, {
		setup,
		scan,
		// Live introspection hook (see dbg / DEBUG_HOOK). Lets the console or the
		// DevTools MCP see what's attached and force a re-scan without a rebuild.
		extras: (scanner) => {
			(window as unknown as Record<string, unknown>)[DEBUG_HOOK] = {
				setVerbose: (v: boolean) => {
					verbose = v;
				},
				reconcile: () => scanner.reconcile(),
				/** The leaves we're actively subscribed to. */
				state: () =>
					scanner.entries().map(([leaf, sub]) => ({
						window: leafWindowLabel(leaf),
						file: (leaf.view as unknown as { file?: TFile }).file?.path,
						seen: sub.seen.size,
						inflight: sub.inflight.size,
					})),
				/** Every Excalidraw leaf and whether we've attached to it. */
				leaves: () => {
					const attached = new Set(scanner.entries().map(([leaf]) => leaf));
					const rows: Array<Record<string, unknown>> = [];
					plugin.app.workspace.iterateAllLeaves((leaf) => {
						if (!isExcalidrawLeaf(leaf)) return;
						rows.push({
							window: leafWindowLabel(leaf),
							file: (leaf.view as unknown as { file?: TFile }).file?.path,
							apiReady: !!getLeafScannerApi(leaf),
							attached: attached.has(leaf),
						});
					});
					return rows;
				},
			};
			return [
				() => {
					delete (window as unknown as Record<string, unknown>)[DEBUG_HOOK];
				},
			];
		},
	});
}
