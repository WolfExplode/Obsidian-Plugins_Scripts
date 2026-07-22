import type { EventRef, TFile, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { localLinkpath } from "./board-render";
import { isExcalidrawLeaf, readSceneElements, resizeSceneElements } from "./excalidraw-view";

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
 * THE FIX: we subscribe to each Excalidraw view's `onChange` and, the first time
 * an embeddable linking to a local media file appears, load the file just far
 * enough to read `videoWidth/videoHeight` (or an image's natural size for
 * animated gif/webp embeds) and rewrite the element's box to that ratio —
 * preserving the placeholder's centre and visual area — as one undoable step.
 *
 * WHY onChange, NOT the drop event: media reaches the scene by several paths —
 * a drag-drop, a paste, or the plugin's "Insert File From Vault" modal (shown for
 * files dragged in from outside the vault, whose element only appears after the
 * user clicks a button, long after any drop). Subscribing to scene changes
 * catches every path with no timing race. Elements already present when we
 * subscribe are seeded as "seen" and never touched, so a video you deliberately
 * stretched is left alone.
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
/** How long to keep retrying attachment while a view's API finishes mounting. */
const READY_RETRY_MS = 300;
const READY_RETRY_MAX = 20;

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

/** The slice of the Excalidraw imperative API we use for aspect correction. */
interface AspectApi {
	onChange(cb: () => void): () => void;
	getSceneElements(): readonly EmbeddableEl[];
	/** In the bundled Excalidraw this is a boolean property, not a method — some
	 * builds may expose it as a getter/function, so callers handle both. */
	isDestroyed?: boolean | (() => boolean);
}

/**
 * Whether a view's API reports itself torn down, tolerating property-or-method form.
 *
 * DO NOT collapse this to `api.isDestroyed?.()`. In the bundled Excalidraw
 * `isDestroyed` is a boolean *property*, so `?.()` becomes `false.call(api)` and
 * throws "d.call is not a function". That throw is silent and nasty: it fired
 * inside `prune()`, which only iterates once a leaf is attached — so the first
 * (empty) reconcile attached the main window fine, then every later reconcile
 * threw before reaching the popout leaf. Net effect was the corrector working in
 * the main window but never in popouts, with no error surfaced.
 */
function apiDestroyed(api: AspectApi): boolean {
	const d = api.isDestroyed;
	return typeof d === "function" ? d() === true : d === true;
}

function getAspectApi(leaf: WorkspaceLeaf): AspectApi | null {
	const api = (leaf.view as unknown as { excalidrawAPI?: Partial<AspectApi> }).excalidrawAPI;
	if (!api || typeof api.onChange !== "function" || typeof api.getSceneElements !== "function") return null;
	return api as AspectApi;
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
	if (verbose) console.log("[EPR aspect]", ...args);
}

/** "MAIN" or "POPOUT" for a leaf, by which window its view lives in. */
function winLabelOf(leaf: WorkspaceLeaf): "MAIN" | "POPOUT" {
	const w = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument?.defaultView;
	return w === window ? "MAIN" : "POPOUT";
}

/** Loads just enough of a media file to read its natural pixel dimensions. */
function probeNaturalSize(win: Window, url: string, kind: "video" | "image"): Promise<{ w: number; h: number } | null> {
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

/** Per-view correction state: unsubscribe handle plus the ids we've resolved. */
interface Subscription {
	unsub: () => void;
	/** Embeddable ids already fitted, seeded, or determined non-media. */
	seen: Set<string>;
	/** Media embeddables currently being probed (avoid double work). */
	inflight: Set<string>;
}

/**
 * Installs the media aspect-ratio corrector across every Excalidraw view — main
 * window and popouts alike — attaching to new views as they mount and detaching
 * as they close. Returns a dispose function. Path-independent: it reacts to scene
 * changes, so it needs no drop hook.
 */
export function attachVideoAspectCorrector(plugin: ExcalidrawPureRefPlugin): () => void {
	const subs = new Map<WorkspaceLeaf, Subscription>();
	let disposed = false;
	let retryTimer: number | null = null;
	let retriesLeft = READY_RETRY_MAX;

	const scanLeaf = (leaf: WorkspaceLeaf, seen: Set<string>, inflight: Set<string>) => {
		if (disposed) return;
		const boardPath = (leaf.view as unknown as { file?: TFile }).file?.path;
		if (!boardPath) return;
		const win = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument?.defaultView ?? window;
		const winLabel = winLabelOf(leaf);

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
				if (disposed || !natural) {
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

	const attachToLeaf = (leaf: WorkspaceLeaf): boolean => {
		if (subs.has(leaf)) return true;
		if (!isExcalidrawLeaf(leaf)) return true; // not our concern; treat as "settled"
		const api = getAspectApi(leaf);
		if (!api) {
			dbg(winLabelOf(leaf), "leaf not ready (no API yet)");
			return false; // an Excalidraw view whose API hasn't mounted yet
		}

		const seen = new Set<string>();
		const inflight = new Set<string>();
		// Seed with whatever's already on the canvas so pre-existing media (which
		// the user may have sized on purpose) is never touched — only new inserts.
		try {
			for (const el of api.getSceneElements()) {
				if (el.type === "embeddable" && el.id) seen.add(el.id);
			}
		} catch (err) {
			dbg(winLabelOf(leaf), "seed getSceneElements threw", err);
			return false;
		}
		let unsub: () => void;
		try {
			unsub = api.onChange(() => scanLeaf(leaf, seen, inflight));
		} catch (err) {
			dbg(winLabelOf(leaf), "onChange subscribe threw", err);
			return false;
		}
		subs.set(leaf, { unsub, seen, inflight });
		dbg("attached to", winLabelOf(leaf), "leaf", (leaf.view as unknown as { file?: TFile }).file?.path, "seeded", seen.size);
		return true;
	};

	/** Drops subscriptions for views that have closed or been destroyed. */
	const prune = () => {
		for (const [leaf, sub] of subs) {
			const api = getAspectApi(leaf);
			const gone = !isExcalidrawLeaf(leaf) || !api || apiDestroyed(api);
			if (gone) {
				try {
					sub.unsub();
				} catch {
					/* view already torn down */
				}
				subs.delete(leaf);
			}
		}
	};

	// Attach to every current Excalidraw view; report whether any is still mounting.
	const reconcile = () => {
		if (disposed) return;
		prune();
		let allReady = true;
		let excalidrawLeaves = 0;
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!isExcalidrawLeaf(leaf)) return;
			excalidrawLeaves++;
			if (!attachToLeaf(leaf)) allReady = false;
		});
		dbg("reconcile: excalidrawLeaves =", excalidrawLeaves, "attached =", subs.size, "allReady =", allReady);
		// A just-opened view's imperative API mounts a beat after the workspace
		// event fires; keep retrying briefly until it's there.
		if (!allReady && retriesLeft > 0 && retryTimer == null) {
			retriesLeft--;
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				reconcile();
			}, READY_RETRY_MS);
		} else if (allReady) {
			retriesLeft = READY_RETRY_MAX;
		}
	};

	const refs: EventRef[] = [
		plugin.app.workspace.on("layout-change", reconcile),
		plugin.app.workspace.on("active-leaf-change", reconcile),
	];
	reconcile();

	// Live introspection hook (see dbg / DEBUG_HOOK). Lets the console or the
	// DevTools MCP see what's attached and force a re-scan without a rebuild.
	(window as unknown as Record<string, unknown>)[DEBUG_HOOK] = {
		setVerbose: (v: boolean) => {
			verbose = v;
		},
		reconcile,
		/** The leaves we're actively subscribed to. */
		state: () =>
			Array.from(subs.entries()).map(([leaf, sub]) => ({
				window: winLabelOf(leaf),
				file: (leaf.view as unknown as { file?: TFile }).file?.path,
				seen: sub.seen.size,
				inflight: sub.inflight.size,
			})),
		/** Every Excalidraw leaf and whether we've attached to it. */
		leaves: () => {
			const rows: Array<Record<string, unknown>> = [];
			plugin.app.workspace.iterateAllLeaves((leaf) => {
				if (!isExcalidrawLeaf(leaf)) return;
				rows.push({
					window: winLabelOf(leaf),
					file: (leaf.view as unknown as { file?: TFile }).file?.path,
					apiReady: !!getAspectApi(leaf),
					attached: subs.has(leaf),
				});
			});
			return rows;
		},
	};

	return () => {
		disposed = true;
		if (retryTimer != null) window.clearTimeout(retryTimer);
		for (const ref of refs) plugin.app.workspace.offref(ref);
		for (const sub of subs.values()) {
			try {
				sub.unsub();
			} catch {
				/* ignore */
			}
		}
		subs.clear();
		delete (window as unknown as Record<string, unknown>)[DEBUG_HOOK];
	};
}
