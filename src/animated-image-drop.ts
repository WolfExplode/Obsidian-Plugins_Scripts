import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { deleteSceneElements, getSceneElementFile, readSceneElements } from "./excalidraw-view";
import { attachPerLeafScanner, onEvent, type LeafScannerApi, type LeafScannerHandle } from "./leaf-scanner";

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
 * element. Then, like the video aspect corrector (video-aspect.ts), watch each
 * view's scene changes — see leaf-scanner.ts for that shared lifecycle — for a
 * genuinely new `image` element whose backing file (resolved via
 * `excalidrawData.getFile`, the same registry those correctors read) is
 * animated. When found: insert an `embeddable` at the same box via
 * ExcalidrawAutomate's public `addEmbeddable`, then delete the original image
 * element. The result carries the exact box Excalidraw's own native image
 * sizing already computed, so no placeholder-size guess is needed.
 *
 * Elements already present when we subscribe are seeded as "seen" and never
 * touched, so an existing gif you deliberately kept as a static image is left
 * alone; only genuinely new inserts are converted.
 *
 * WHY TRACKING IS BY fileId: copying an image element keeps its fileId, so a
 * fileId converted once (anywhere) is never reconsidered, and a copy of an
 * already-converted embeddable is left as whatever the user pasted.
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
 * holds. On a heavy board the live scene can take minutes to populate, so this
 * is the only reliable "pre-existing" set.
 */
function getPersistedImageSeed(leaf: WorkspaceLeaf): { ids: Set<string>; fileIds: Set<string> } | null {
	const scene = (leaf.view as unknown as { excalidrawData?: { scene?: { elements?: readonly ImageEl[] } } })
		.excalidrawData?.scene;
	const elements = scene?.elements;
	if (!elements) return null;
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

interface ExcalidrawAutomateLike {
	addEmbeddable(topX: number, topY: number, width: number, height: number, url?: string, file?: unknown): string | null;
	addElementsToView?(repositionToCursor?: boolean, save?: boolean, newElementsOnTop?: boolean): Promise<boolean>;
	destroy?(): void;
}

interface ExcalidrawAutomateFactory {
	getAPI?(view?: unknown): ExcalidrawAutomateLike | null;
}

/**
 * Creates a disposable EA for one conversion. `window.ExcalidrawAutomate` is
 * the upstream plugin's long-lived factory, not an EA instance we own: calling
 * `destroy()` on it clears its plugin reference and breaks upstream on-load
 * scripts the next time a drawing is opened.
 */
function getExcalidrawAutomate(plugin: ExcalidrawPureRefPlugin, view: unknown): ExcalidrawAutomateLike | null {
	const fromWindow = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateFactory }).ExcalidrawAutomate;
	if (fromWindow?.getAPI) return fromWindow.getAPI(view);
	const excalidrawPlugin = (
		plugin.app as unknown as { plugins?: { plugins?: Record<string, { ea?: ExcalidrawAutomateFactory }> } }
	).plugins?.plugins?.["obsidian-excalidraw-plugin"];
	return excalidrawPlugin?.ea?.getAPI?.(view) ?? null;
}

/** Per-view state: the image ids/fileIds already accounted for. */
interface ConversionState {
	seen: Set<string>;
	inflight: Set<string>;
	/** Saved-scene state at attachment time; never refreshed during an import. */
	persisted: { ids: Set<string>; fileIds: Set<string> } | null;
	persistedCaptured: boolean;
}

/**
 * Installs the animated-image-to-embeddable converter across every Excalidraw
 * view — main window and popouts alike. Returns a dispose function.
 */
export function attachAnimatedImageEmbedConversion(plugin: ExcalidrawPureRefPlugin): () => void {
	// fileIds already resolved on any board. A copy retains this guard; it is
	// released only when the backing vault file is deleted, because a fileId is
	// content-derived and can then represent a genuine reimport of the same GIF.
	const resolvedFileIds = new Set<string>();
	const filePathById = new Map<string, string>();

	const convert = async (leaf: WorkspaceLeaf, id: string, fileId: string): Promise<boolean> => {
		// Fetch the current element immediately before conversion. Other import
		// correctors may have updated its box while its backing file was loading.
		const el = (readSceneElements(leaf) ?? []).find((raw) => (raw as ImageEl).id === id) as ImageEl | undefined;
		if (!el || el.type !== "image" || el.isDeleted || el.fileId !== fileId) return false;
		const file = getSceneElementFile(leaf, fileId);
		if (!file) return false;
		const ea = getExcalidrawAutomate(plugin, leaf.view);
		if (!ea) {
			console.error("[Excalidraw PureRef] ExcalidrawAutomate is unavailable — is the Excalidraw plugin enabled?");
			return false;
		}
		try {
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

	const setup = (leaf: WorkspaceLeaf, api: LeafScannerApi): ConversionState | null => {
		const seen = new Set<string>();
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
			return null;
		}
		// Also seed from the parsed on-disk scene — see getPersistedImageSeed's
		// doc comment for why the live canvas alone isn't a reliable snapshot.
		const persisted = getPersistedImageSeed(leaf);
		if (persisted) {
			for (const id of persisted.ids) seen.add(id);
			for (const fileId of persisted.fileIds) resolvedFileIds.add(fileId);
		}
		return { seen, inflight: new Set<string>(), persisted, persistedCaptured: persisted !== null };
	};

	const scan = (leaf: WorkspaceLeaf, state: ConversionState, scanner: LeafScannerHandle<ConversionState>) => {
		const { seen, inflight } = state;

		// This is deliberately an attachment-time baseline. A multi-file import
		// can be autosaved before its files finish registering; treating that live
		// saved state as pre-existing would skip the GIF conversion entirely.
		if (!state.persistedCaptured) {
			const persisted = getPersistedImageSeed(leaf);
			if (persisted) {
				state.persisted = persisted;
				state.persistedCaptured = true;
			}
		}
		const persisted = state.persisted;

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
				if (scanner.isDisposed()) return;
				if (converted) {
					seen.add(id);
					resolvedFileIds.add(fileId);
				}
			});
		}
	};

	return attachPerLeafScanner<ConversionState>(plugin, {
		setup,
		scan,
		extras: () => {
			// Released through the vault, NOT the workspace: an EventRef must be
			// unregistered on the same Events instance it was registered on.
			const vault = plugin.app.vault;
			return [
				onEvent(vault, () =>
					vault.on("delete", (file) => {
						for (const [fileId, path] of filePathById) {
							if (path !== file.path) continue;
							resolvedFileIds.delete(fileId);
							filePathById.delete(fileId);
						}
					}),
				),
			];
		},
	});
}
