import type { EventRef, WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	deleteSceneElements,
	getSceneElementFile,
	isExcalidrawLeaf,
	readSceneElements,
} from "./excalidraw-view";

/**
 * Converts a freshly-inserted animated image (gif/webp/apng) from a static
 * `image` element into a playing `embeddable`.
 *
 * THE UPSTREAM BUG: the Excalidraw plugin's own "Insert File From Vault" modal
 * correctly offers both "as Image" and "as Embeddable" for an animated image,
 * because it checks the file against its ANIMATED_IMAGE_TYPES list. But that
 * modal is never reached from a raw OS file drop: ExcalidrawView.onDrop's
 * external-file branch only checks the plain IMAGE_TYPES list (which also
 * contains "gif"/"webp"/"apng") and, when it matches, inserts a static Image
 * directly — the modal only opens for extensions IMAGE_TYPES doesn't
 * recognize at all (e.g. video). A dropped gif therefore always lands as a
 * non-animating raster image, with no drag-drop way to choose Embeddable.
 * Confirmed by reading the plugin's onDrop implementation; the plugin author
 * confirmed this is deliberate and suggested a custom onDrop hook — except
 * onDropHook is never invoked on this exact code path either.
 *
 * FIRST ATTEMPT, REJECTED: intercepting the drop event ourselves (capture
 * phase, like popout-drop-bridge.ts) and importing the file into the vault by
 * hand. That bypassed Excalidraw's own import pipeline entirely, which broke
 * two things it normally gets right for free: placing the file under
 * Obsidian's configured attachment folder, and clearing the "Import external
 * file..." drag-hint overlay it removes at the top of its own onDrop handler
 * (`this.draginfoDiv && ...removeChild...`) — which never got a chance to run.
 *
 * THE FIX HERE: don't touch the drop at all. Let Excalidraw's native handler
 * import the file exactly as it always does (right attachment folder, right
 * overlay cleanup, its own collision handling), landing as a static `image`
 * element. Then, like the video aspect corrector (video-aspect.ts), subscribe
 * to each view's `onChange` and watch for a
 * genuinely new `image` element whose backing file (resolved via
 * `excalidrawData.getFile`, the same registry those correctors read) is
 * animated. When found: insert an `embeddable` at the same box via
 * ExcalidrawAutomate's public `addEmbeddable`, then delete the original image
 * element. The result carries the exact box Excalidraw's own native image
 * sizing already computed, so no placeholder-size guess is needed.
 *
 * WHY onChange, NOT the drop event, for detection too: media reaches the
 * scene via drag-drop, paste, or the "Insert File From Vault" modal — see the
 * identical rationale in video-aspect.ts. Elements already present when we
 * subscribe are seeded as "seen" and never touched, so an existing gif you
 * deliberately kept as a static image is left alone; only genuinely new
 * inserts are converted.
 *
 * WHY TRACKING IS BY fileId: copying an image
 * element keeps its fileId, so a fileId converted once (anywhere) is never
 * reconsidered, and a copy of an already-converted embeddable is left as
 * whatever the user pasted.
 */

/** Extensions the upstream modal itself treats as "animated" (its ANIMATED_IMAGE_TYPES minus svg — a dropped svg is already fine as a static image). */
const ANIMATED_EXTENSIONS = new Set(["gif", "webp", "apng"]);

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

/**
 * Reads the image element ids and fileIds straight out of the file's parsed,
 * on-disk scene — independent of whatever the live imperative API currently
 * holds. On a
 * heavy board the live scene can take minutes to populate, so this is the
 * only reliable "pre-existing" set.
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

/** The slice of the Excalidraw imperative API we use. */
interface ConversionApi {
	onChange(cb: () => void): () => void;
	getSceneElements(): readonly ImageEl[];
	/** In the bundled Excalidraw this is a boolean property, not a method — some
	 * builds may expose it as a getter/function, so callers handle both. */
	isDestroyed?: boolean | (() => boolean);
}

interface ExcalidrawAutomateLike {
	reset?(): void;
	setView?(view?: unknown, show?: boolean): unknown;
	addEmbeddable(topX: number, topY: number, width: number, height: number, url?: string, file?: unknown): string | null;
	addElementsToView?(repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean): Promise<boolean>;
	destroy?(): void;
}

function getExcalidrawAutomate(plugin: ExcalidrawPureRefPlugin): ExcalidrawAutomateLike | null {
	const fromWindow = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateLike }).ExcalidrawAutomate;
	if (fromWindow) return fromWindow;
	const excalidrawPlugin = (
		plugin.app as unknown as { plugins?: { plugins?: Record<string, { ea?: ExcalidrawAutomateLike }> } }
	).plugins?.plugins?.["obsidian-excalidraw-plugin"];
	return excalidrawPlugin?.ea ?? null;
}

/**
 * Whether a view's API reports itself torn down, tolerating property-or-method
 * form. See the identical note in video-aspect.ts.
 */
function apiDestroyed(api: ConversionApi): boolean {
	const d = api.isDestroyed;
	return typeof d === "function" ? d() === true : d === true;
}

function getConversionApi(leaf: WorkspaceLeaf): ConversionApi | null {
	const api = (leaf.view as unknown as { excalidrawAPI?: Partial<ConversionApi> }).excalidrawAPI;
	if (!api || typeof api.onChange !== "function" || typeof api.getSceneElements !== "function") return null;
	return api as ConversionApi;
}

/** How long to keep retrying attachment while a view's API finishes mounting. */
const READY_RETRY_MS = 300;
const READY_RETRY_MAX = 20;

/**
 * Whether the Excalidraw view is still loading its saved scene into the API.
 * See the identical check in video-aspect.ts.
 */
function isStillLoading(leaf: WorkspaceLeaf): boolean {
	const semaphores = (leaf.view as unknown as { semaphores?: { justLoaded?: boolean } }).semaphores;
	return semaphores?.justLoaded === true;
}

/** Per-view state: unsubscribe handle plus the image ids/fileIds already accounted for. */
interface Subscription {
	unsub: () => void;
	seen: Set<string>;
	inflight: Set<string>;
	/** Saved-scene state at attachment time; never refreshed during an import. */
	persisted: { ids: Set<string>; fileIds: Set<string> } | null;
	persistedCaptured: boolean;
}

/**
 * Installs the animated-image-to-embeddable converter across every Excalidraw
 * view — main window and popouts alike — attaching to new views as they mount
 * and detaching as they close. Returns a dispose function. Path-independent:
 * it reacts to scene changes, so it needs no drop hook.
 */
export function attachAnimatedImageEmbedConversion(plugin: ExcalidrawPureRefPlugin): () => void {
	const subs = new Map<WorkspaceLeaf, Subscription>();
	// fileIds already resolved on any board. A copy retains this guard; it is
	// released only when the backing vault file is deleted, because a fileId is
	// content-derived and can then represent a genuine reimport of the same GIF.
	const resolvedFileIds = new Set<string>();
	const filePathById = new Map<string, string>();
	let disposed = false;
	let retryTimer: number | null = null;
	let retriesLeft = READY_RETRY_MAX;

	const convert = async (leaf: WorkspaceLeaf, id: string, fileId: string): Promise<boolean> => {
		// Fetch the current element immediately before conversion. Other import
		// correctors may have updated its box while its backing file was loading.
		const el = (readSceneElements(leaf) ?? []).find((raw) => (raw as ImageEl).id === id) as ImageEl | undefined;
		if (!el || el.type !== "image" || el.isDeleted || el.fileId !== fileId) return false;
		const file = getSceneElementFile(leaf, fileId);
		if (!file) return false;
		const ea = getExcalidrawAutomate(plugin);
		if (!ea) {
			console.error("[Excalidraw PureRef] ExcalidrawAutomate is unavailable — is the Excalidraw plugin enabled?");
			return false;
		}
		try {
			ea.reset?.();
			ea.setView?.(leaf.view, false);
			const embeddableId = ea.addEmbeddable(el.x ?? 0, el.y ?? 0, el.width ?? 500, el.height ?? 500, undefined, file);
			if (!embeddableId) return false;
			const added = await ea.addElementsToView?.(false, true, true);
			if (added === false) return false;
			return deleteSceneElements(leaf, [id]);
		} catch (error) {
			console.error("[Excalidraw PureRef] failed to convert animated image to an embeddable.", error);
			return false;
		} finally {
			ea.destroy?.();
		}
	};

	const scanLeaf = (leaf: WorkspaceLeaf, sub: Subscription) => {
		if (disposed) return;
		const { seen, inflight } = sub;

		// This is deliberately an attachment-time baseline. A multi-file import
		// can be autosaved before its files finish registering; treating that live
		// saved state as pre-existing would skip the GIF conversion entirely.
		if (!sub.persistedCaptured) {
			const persisted = getPersistedImageSeed(leaf);
			if (persisted) {
				sub.persisted = persisted;
				sub.persistedCaptured = true;
			}
		}
		const persisted = sub.persisted;

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

			const fileId = el.fileId;
			if (!fileId) continue; // placeholder not yet bound to a file — retry next change
			if (resolvedFileIds.has(fileId)) {
				seen.add(id); // a copy of an element already resolved elsewhere
				continue;
			}

			const file = getSceneElementFile(leaf, fileId);
			if (!file) continue; // registry not populated yet; leave unseen to retry on next change
			filePathById.set(fileId, file.path);
			if (!ANIMATED_EXTENSIONS.has(file.extension.toLowerCase())) {
				seen.add(id);
				resolvedFileIds.add(fileId);
				continue;
			}

			inflight.add(id);
			void convert(leaf, id, fileId).then((converted) => {
				inflight.delete(id);
				if (converted) {
					seen.add(id);
					resolvedFileIds.add(fileId);
				}
			});
		}
	};

	const attachToLeaf = (leaf: WorkspaceLeaf): boolean => {
		if (subs.has(leaf)) return true;
		if (!isExcalidrawLeaf(leaf)) return true; // not our concern; treat as "settled"
		const api = getConversionApi(leaf);
		if (!api) return false; // an Excalidraw view whose API hasn't mounted yet
		if (isStillLoading(leaf)) return false; // wait for the persisted elements to land before seeding "seen"

		const seen = new Set<string>();
		const inflight = new Set<string>();
		// Seed with whatever's already on the canvas so pre-existing images (which
		// may deliberately be a static gif) are never touched — only new inserts.
		try {
			for (const el of api.getSceneElements()) {
				if (el.type === "image" && el.id) {
					seen.add(el.id);
					if (el.fileId) resolvedFileIds.add(el.fileId);
				}
			}
		} catch {
			return false;
		}
		// Also seed from the parsed on-disk scene — see getPersistedImageSeed's
		// doc comment for why the live canvas alone isn't a reliable snapshot.
		const persisted = getPersistedImageSeed(leaf);
		if (persisted) {
			for (const id of persisted.ids) seen.add(id);
			for (const fileId of persisted.fileIds) resolvedFileIds.add(fileId);
		}
		const sub: Subscription = {
			unsub: () => {},
			seen,
			inflight,
			persisted,
			persistedCaptured: persisted !== null,
		};
		try {
			sub.unsub = api.onChange(() => scanLeaf(leaf, sub));
		} catch {
			return false;
		}
		subs.set(leaf, sub);
		return true;
	};

	/** Drops subscriptions for views that have closed or been destroyed. */
	const prune = () => {
		for (const [leaf, sub] of subs) {
			const api = getConversionApi(leaf);
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
		plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!isExcalidrawLeaf(leaf)) return;
			if (!attachToLeaf(leaf)) allReady = false;
		});
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
		plugin.app.vault.on("delete", (file) => {
			for (const [fileId, path] of filePathById) {
				if (path !== file.path) continue;
				resolvedFileIds.delete(fileId);
				filePathById.delete(fileId);
			}
		}),
	];
	reconcile();

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
	};
}
