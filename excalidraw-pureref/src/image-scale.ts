import type { EventRef, TFile, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { isExcalidrawLeaf, readSceneElements, resizeSceneElements } from "./excalidraw-view";

/**
 * Re-sizes freshly-inserted image elements to their true native pixel dimensions,
 * so a reference board reads at 1:1 device pixels — PureRef's default. If one
 * image is 10× the resolution of another, it ends up 10× larger on canvas, and
 * every image lines up pixel-for-pixel at 100% zoom.
 *
 * WHY EXCALIDRAW GETS THIS "WRONG" for a reference board: on insert Excalidraw
 * reads the decoded bitmap's `naturalWidth/naturalHeight` and *preserves the
 * aspect ratio*, but clamps the magnitude — the core editor caps height to a
 * viewport-relative box (App.tsx `getImageNaturalDimensions`), and the Obsidian
 * host caps the largest side to `MAX_IMAGE_SIZE`. The clamp is per-image, so it
 * erases relative resolution: a 6000px-tall image and a 600px-tall image both
 * land at the same cap. Aspect is fine; only the scale is wrong.
 *
 * THE FIX: we subscribe to each Excalidraw view's `onChange` and, the first time
 * a new image element appears, read its bytes from the public scene files map
 * (`api.getFiles()[fileId].dataURL` — no dependency on the Excalidraw plugin's
 * own code, per ADR 0001), decode them to recover `naturalWidth/naturalHeight`,
 * and rewrite the element's box to exactly that size — keeping its centre fixed —
 * as one undoable step. Aspect already matches, so if the element is already at
 * native size (a small image that was never clamped) it's left untouched.
 *
 * WHY onChange, NOT the drop event: images reach the scene by several paths — a
 * drag-drop, a paste, or the host's "Insert File From Vault" modal (whose element
 * only appears after a click, long after any drop). Subscribing to scene changes
 * catches every path with no timing race. Elements already present when we
 * subscribe are seeded as "seen" and never touched, so an image you deliberately
 * resized is left alone; only genuinely new inserts are corrected.
 *
 * Structure mirrors the video aspect corrector (video-aspect.ts) — same
 * main+popout reconcile, ready-retry, realm-correct decoding, and debug hook.
 */

/** A measured size within this fraction of the current one is left alone (already native). */
const SIZE_EPSILON = 0.01;
/** How long to keep retrying attachment while a view's API finishes mounting. */
const READY_RETRY_MS = 300;
const READY_RETRY_MAX = 20;

interface ImageEl {
	id?: string;
	type?: string;
	fileId?: string | null;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	isDeleted?: boolean;
}

/** The slice of the Excalidraw imperative API we use for native-size correction. */
interface ScaleApi {
	onChange(cb: () => void): () => void;
	getSceneElements(): readonly ImageEl[];
	/** The scene's binary files, keyed by an image element's `fileId`. */
	getFiles(): Record<string, { dataURL?: string } | undefined>;
	/** In the bundled Excalidraw this is a boolean property, not a method — some
	 * builds may expose it as a getter/function, so callers handle both. */
	isDestroyed?: boolean | (() => boolean);
}

/**
 * Whether a view's API reports itself torn down, tolerating property-or-method form.
 *
 * DO NOT collapse this to `api.isDestroyed?.()`. In the bundled Excalidraw
 * `isDestroyed` is a boolean *property*, so `?.()` becomes `false.call(api)` and
 * throws. See the identical note in video-aspect.ts for the full story.
 */
function apiDestroyed(api: ScaleApi): boolean {
	const d = api.isDestroyed;
	return typeof d === "function" ? d() === true : d === true;
}

function getScaleApi(leaf: WorkspaceLeaf): ScaleApi | null {
	const api = (leaf.view as unknown as { excalidrawAPI?: Partial<ScaleApi> }).excalidrawAPI;
	if (
		!api ||
		typeof api.onChange !== "function" ||
		typeof api.getSceneElements !== "function" ||
		typeof api.getFiles !== "function"
	) {
		return null;
	}
	return api as ScaleApi;
}

/**
 * Debug tooling, off by default. Toggle at runtime (incl. via the Obsidian
 * DevTools MCP) with `window.__eprImageScaleDebug.setVerbose(true)`; introspect
 * with `.state()` / `.leaves()`; force a re-scan with `.reconcile()`.
 */
const DEBUG_HOOK = "__eprImageScaleDebug";
let verbose = false;
function dbg(...args: unknown[]): void {
	if (verbose) console.log("[EPR image-scale]", ...args);
}

/** "MAIN" or "POPOUT" for a leaf, by which window its view lives in. */
function winLabelOf(leaf: WorkspaceLeaf): "MAIN" | "POPOUT" {
	const w = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument?.defaultView;
	return w === window ? "MAIN" : "POPOUT";
}

/** Decodes an image data URL far enough to read its natural pixel dimensions. */
function probeImageSize(win: Window, dataURL: string): Promise<{ w: number; h: number } | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: { w: number; h: number } | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = win.setTimeout(() => finish(null), 15000);
		const img = win.document.createElement("img");
		img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
		img.onerror = () => finish(null);
		img.src = dataURL;
	});
}

/**
 * Rewrites `el`'s box to `natural.w × natural.h` scene units (native pixels),
 * keeping its centre fixed. Returns null if the element is already at native size
 * (within SIZE_EPSILON) or its current box is degenerate.
 */
function fitNative(el: ImageEl, natural: { w: number; h: number }) {
	const curW = el.width ?? 0;
	const curH = el.height ?? 0;
	if (curW <= 0 || curH <= 0) return null;
	if (
		Math.abs(curW - natural.w) <= SIZE_EPSILON * natural.w &&
		Math.abs(curH - natural.h) <= SIZE_EPSILON * natural.h
	) {
		return null;
	}
	const cx = (el.x ?? 0) + curW / 2;
	const cy = (el.y ?? 0) + curH / 2;
	return { id: el.id as string, x: cx - natural.w / 2, y: cy - natural.h / 2, width: natural.w, height: natural.h };
}

/** Per-view correction state: unsubscribe handle plus the ids we've resolved. */
interface Subscription {
	unsub: () => void;
	/** Image ids already sized, seeded, or determined unresolvable. */
	seen: Set<string>;
	/** Image ids currently being decoded (avoid double work). */
	inflight: Set<string>;
}

/**
 * Installs the native-pixel image sizer across every Excalidraw view — main
 * window and popouts alike — attaching to new views as they mount and detaching
 * as they close. Returns a dispose function. Path-independent: it reacts to scene
 * changes, so it needs no drop hook.
 */
export function attachImageScaleCorrector(plugin: ExcalidrawPureRefPlugin): () => void {
	const subs = new Map<WorkspaceLeaf, Subscription>();
	let disposed = false;
	let retryTimer: number | null = null;
	let retriesLeft = READY_RETRY_MAX;

	const scanLeaf = (leaf: WorkspaceLeaf, seen: Set<string>, inflight: Set<string>) => {
		if (disposed) return;
		const api = getScaleApi(leaf);
		if (!api) return;
		const win = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument?.defaultView ?? window;
		const winLabel = winLabelOf(leaf);

		let files: Record<string, { dataURL?: string } | undefined>;
		try {
			files = api.getFiles();
		} catch {
			return;
		}

		for (const raw of readSceneElements(leaf) ?? []) {
			const el = raw as ImageEl;
			if (el.type !== "image" || !el.id || el.isDeleted) continue;
			const id = el.id;
			if (seen.has(id) || inflight.has(id)) continue;
			if (!el.fileId) continue; // placeholder not yet bound to a file — retry next change

			const dataURL = files[el.fileId]?.dataURL;
			if (!dataURL) continue; // bytes still loading; leave unseen to retry on next change

			inflight.add(id);
			dbg(winLabel, "probing new image", id, el.fileId);
			void probeImageSize(win, dataURL).then((natural) => {
				inflight.delete(id);
				seen.add(id);
				if (disposed || !natural) {
					dbg(winLabel, "probe failed", id, natural);
					return;
				}
				// Re-read: the element may have moved/resized while we decoded.
				const current = (readSceneElements(leaf) ?? []).find((e) => (e as ImageEl).id === id) as
					| ImageEl
					| undefined;
				if (!current) return;
				const resize = fitNative(current, natural);
				dbg(winLabel, "resize", id, natural, resize ? `-> ${Math.round(resize.width)}x${Math.round(resize.height)}` : "already native");
				if (resize) resizeSceneElements(leaf, [resize]);
			});
		}
	};

	const attachToLeaf = (leaf: WorkspaceLeaf): boolean => {
		if (subs.has(leaf)) return true;
		if (!isExcalidrawLeaf(leaf)) return true; // not our concern; treat as "settled"
		const api = getScaleApi(leaf);
		if (!api) {
			dbg(winLabelOf(leaf), "leaf not ready (no API yet)");
			return false; // an Excalidraw view whose API hasn't mounted yet
		}

		const seen = new Set<string>();
		const inflight = new Set<string>();
		// Seed with whatever's already on the canvas so pre-existing images (which
		// the user may have sized on purpose) are never touched — only new inserts.
		try {
			for (const el of api.getSceneElements()) {
				if (el.type === "image" && el.id) seen.add(el.id);
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
			const api = getScaleApi(leaf);
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
					apiReady: !!getScaleApi(leaf),
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
