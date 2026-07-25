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
 * WHY TRACKING IS BY fileId, NOT ELEMENT id: copying an image element from one
 * board to another gives it a brand-new element id (Excalidraw requires unique
 * ids per scene) but keeps the same fileId — Excalidraw derives fileId from the
 * file's content hash, so the same image always carries the same fileId no
 * matter how many boards it's pasted into. If we tracked "seen" per element id,
 * a copy-paste would look like a fresh insert on the destination board and get
 * forcibly re-scaled to native size, silently overriding whatever size — native
 * or deliberately resized — it had on the source board. Tracking resolved
 * fileIds in one Set shared across every leaf for the plugin's lifetime means a
 * file is auto-fit to native size at most once, ever; every later copy of that
 * same image anywhere keeps whatever size the copy arrived with.
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

/**
 * Whether the Excalidraw view is still loading its saved scene into the API.
 *
 * The Excalidraw plugin sets `view.semaphores.justLoaded = true` before it
 * populates the API with a file's persisted elements, and clears it again on
 * the first `onChange` after that population completes. Without this check we
 * seed our "seen" set from `getSceneElements()` the instant the API object
 * exists, which can be *before* the persisted elements have been loaded into
 * it — every image already on a board opened for the first time (e.g. a board
 * created before this plugin was installed) then looks like a brand-new
 * insert on the next `onChange` and gets force-fit to native pixel size.
 * Treating `justLoaded === true` as "not ready yet" defers seeding until
 * after the real scene has landed. If the property is absent (older/forked
 * Excalidraw builds), we fail open and seed immediately as before.
 */
function isStillLoading(leaf: WorkspaceLeaf): boolean {
	const semaphores = (leaf.view as unknown as { semaphores?: { justLoaded?: boolean } }).semaphores;
	return semaphores?.justLoaded === true;
}

/**
 * Reads the image element ids and fileIds straight out of the file's *parsed,
 * on-disk* scene — `view.excalidrawData.scene`, the plain object the
 * Excalidraw plugin gets from `JSON.parse`-ing the saved markdown block,
 * independent of whatever the live imperative API currently holds.
 *
 * WHY THIS EXISTS, NOT JUST THE LIVE-API SEED AT ATTACH: on a board with many
 * embedded images the live scene (`api.getSceneElements()`) can populate over
 * *minutes*, not milliseconds — observed live via the Obsidian DevTools MCP,
 * a single board kept surfacing "new" images in bursts several minutes apart
 * as the user scrolled, long after any reasonable settle window. Gating
 * on load flags or quiescence can't outlast an arbitrarily slow/streamed
 * live population. The parsed on-disk scene has no such streaming: it's one
 * synchronous `JSON.parse` of already-in-memory text, done before any
 * per-image byte decoding starts, so it reliably lists every element that
 * was actually saved to the file — the true "pre-existing" set — regardless
 * of how slowly the live API catches up to it.
 */
function getPersistedImageSeed(leaf: WorkspaceLeaf): { ids: Set<string>; fileIds: Set<string> } | null {
	const scene = (leaf.view as unknown as { excalidrawData?: { scene?: { elements?: readonly ImageEl[] } } })
		.excalidrawData?.scene;
	const elements = scene?.elements;
	if (!Array.isArray(elements)) return null;
	const ids = new Set<string>();
	const fileIds = new Set<string>();
	for (const el of elements) {
		if (el?.type === "image" && el.id) {
			ids.add(el.id);
			if (el.fileId) fileIds.add(el.fileId);
		}
	}
	return { ids, fileIds };
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
	// fileIds already resolved (corrected or found already-native) on ANY board.
	// Shared across every leaf so a copy-pasted element — same fileId, new element
	// id — is never re-corrected. See the fileId-vs-element-id note above.
	const resolvedFileIds = new Set<string>();
	let disposed = false;
	let retryTimer: number | null = null;
	let retriesLeft = READY_RETRY_MAX;

	const scanLeaf = (leaf: WorkspaceLeaf, sub: Subscription) => {
		if (disposed) return;
		const api = getScaleApi(leaf);
		if (!api) return;
		const win = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl?.ownerDocument?.defaultView ?? window;
		const winLabel = winLabelOf(leaf);
		const { seen, inflight } = sub;

		let files: Record<string, { dataURL?: string } | undefined>;
		try {
			files = api.getFiles();
		} catch {
			return;
		}

		// The live scene can still be catching up to the on-disk file (see the
		// getPersistedImageSeed doc comment) — re-check the persisted scene on
		// every scan, not just at attach, so images that only just streamed into
		// the parsed data get folded into `seen` instead of treated as imports.
		const persisted = getPersistedImageSeed(leaf);

		for (const raw of readSceneElements(leaf) ?? []) {
			const el = raw as ImageEl;
			if (el.type !== "image" || !el.id || el.isDeleted) continue;
			const id = el.id;
			if (seen.has(id) || inflight.has(id)) continue;

			if (persisted?.ids.has(id) || (el.fileId && persisted?.fileIds.has(el.fileId))) {
				// Present in the saved file — pre-existing, not an import.
				seen.add(id);
				if (el.fileId) resolvedFileIds.add(el.fileId);
				continue;
			}

			if (!el.fileId) continue; // placeholder not yet bound to a file — retry next change

			if (resolvedFileIds.has(el.fileId)) {
				// Already resolved elsewhere (e.g. this is a copy of an element from
				// another board) — leave its size exactly as pasted.
				seen.add(id);
				continue;
			}

			const dataURL = files[el.fileId]?.dataURL;
			if (!dataURL) continue; // bytes still loading; leave unseen to retry on next change

			inflight.add(id);
			const fileId = el.fileId;
			dbg(winLabel, "probing new image", id, fileId);
			void probeImageSize(win, dataURL).then((natural) => {
				inflight.delete(id);
				seen.add(id);
				resolvedFileIds.add(fileId);
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
		if (isStillLoading(leaf)) {
			dbg(winLabelOf(leaf), "leaf still loading its saved scene (justLoaded)");
			return false; // wait for the persisted elements to land before seeding "seen"
		}

		const seen = new Set<string>();
		const inflight = new Set<string>();
		// Seed with whatever's already on the canvas so pre-existing images (which
		// the user may have sized on purpose) are never touched — only new inserts.
		try {
			for (const el of api.getSceneElements()) {
				if (el.type === "image" && el.id) {
					seen.add(el.id);
					if (el.fileId) resolvedFileIds.add(el.fileId);
				}
			}
		} catch (err) {
			dbg(winLabelOf(leaf), "seed getSceneElements threw", err);
			return false;
		}
		// Also seed from the parsed on-disk scene — see getPersistedImageSeed's
		// doc comment for why the live canvas alone isn't a reliable snapshot.
		const persisted = getPersistedImageSeed(leaf);
		if (persisted) {
			for (const id of persisted.ids) seen.add(id);
			for (const fileId of persisted.fileIds) resolvedFileIds.add(fileId);
		}
		const sub: Subscription = { unsub: () => {}, seen, inflight };
		try {
			sub.unsub = api.onChange(() => scanLeaf(leaf, sub));
		} catch (err) {
			dbg(winLabelOf(leaf), "onChange subscribe threw", err);
			return false;
		}
		subs.set(leaf, sub);
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
		/** fileIds resolved (corrected or already-native) anywhere this session. */
		resolvedFileIds: () => resolvedFileIds.size,
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
