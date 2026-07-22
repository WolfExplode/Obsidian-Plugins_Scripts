import type { App, TFile, WorkspaceLeaf } from "obsidian";
import {
	isPackable,
	planPack,
	planOptimalPack,
	type PackDirection,
	type PackElement,
	type PackMove,
} from "./pack-elements";

/**
 * The Excalidraw community plugin registers its view under this type id.
 * We only ever check the view type / file extension from the outside —
 * per ADR 0001 we never import or depend on the Excalidraw plugin's own code.
 */
export const EXCALIDRAW_VIEW_TYPE = "excalidraw";

export function isExcalidrawLeaf(leaf: WorkspaceLeaf | null): boolean {
	if (!leaf) return false;
	return leaf.view.getViewType() === EXCALIDRAW_VIEW_TYPE;
}

export function getExcalidrawFileForLeaf(leaf: WorkspaceLeaf | null): TFile | null {
	if (!isExcalidrawLeaf(leaf)) return null;
	const view = leaf!.view as unknown as { file?: TFile };
	return view.file ?? null;
}

/** Returns the active Board's file if the currently focused leaf is an Excalidraw view. */
export function getActiveExcalidrawFile(app: App): TFile | null {
	return getExcalidrawFileForLeaf(app.workspace.activeLeaf);
}

/** The persisted slice of an Excalidraw view's camera: where it's scrolled and how zoomed. */
export interface ExcalidrawViewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
}

/** Viewport plus the container size it was measured against — needed to re-center a mirror. */
interface ExcalidrawViewState extends ExcalidrawViewport {
	width: number;
	height: number;
}

/**
 * The Excalidraw view's live imperative API. Per ADR 0001 we depend only on this
 * public runtime object (the same one the Excalidraw React host exposes), never
 * on the plugin's source. Shapes are the minimal slice we read/write.
 */
/** The Excalidraw element fields we read for bounding-box math and packing. */
interface SceneElement extends PackElement {
	version?: number;
}

interface ExcalidrawApi {
	getAppState(): {
		scrollX: number;
		scrollY: number;
		zoom: { value: number };
		width: number;
		height: number;
		/** The canvas's top-left offset from the page, used for pointer→scene math. */
		offsetLeft?: number;
		offsetTop?: number;
		zenModeEnabled?: boolean;
		boxSelectionMode?: "contain" | "overlap";
		selectedElementIds?: Record<string, boolean>;
	};
	getSceneElements?(): readonly SceneElement[];
	/** The scene's binary files, keyed by an image element's `fileId`. */
	getFiles?(): Record<string, { dataURL?: string } | undefined>;
}

interface ExcalidrawViewLike {
	containerEl?: HTMLElement;
	excalidrawAPI?: ExcalidrawApi;
	updateScene?(scene: {
		elements?: readonly unknown[];
		appState?: Record<string, unknown>;
		captureUpdate?: string;
		commitToHistory?: boolean;
	}): void;
}

interface AppWithPlugins {
	plugins?: { plugins?: Record<string, unknown> };
}

/** Whether the Excalidraw dependency has completed plugin registration. */
export function isExcalidrawPluginAvailable(app: App): boolean {
	return !!(app as unknown as AppWithPlugins).plugins?.plugins?.["obsidian-excalidraw-plugin"];
}

function getExcalidrawView(leaf: WorkspaceLeaf | null): ExcalidrawViewLike | null {
	if (!isExcalidrawLeaf(leaf)) return null;
	return leaf!.view as unknown as ExcalidrawViewLike;
}

function getExcalidrawApi(leaf: WorkspaceLeaf | null): ExcalidrawApi | null {
	const view = getExcalidrawView(leaf);
	return view?.excalidrawAPI ?? null;
}

function updateExcalidrawScene(leaf: WorkspaceLeaf | null, appState: Record<string, unknown>): boolean {
	const view = getExcalidrawView(leaf);
	if (!view?.excalidrawAPI || !view.updateScene) return false;
	try {
		view.updateScene({ appState });
		return true;
	} catch {
		return false;
	}
}

function readViewState(leaf: WorkspaceLeaf | null): ExcalidrawViewState | null {
	const api = getExcalidrawApi(leaf);
	if (!api) return null;
	try {
		const s = api.getAppState();
		if (!s || typeof s.scrollX !== "number") return null;
		return {
			scrollX: s.scrollX,
			scrollY: s.scrollY,
			zoom: s.zoom?.value ?? 1,
			width: s.width,
			height: s.height,
		};
	} catch {
		return null;
	}
}

/** Reads just the camera (scroll + zoom) from a leaf's Excalidraw view, if available. */
export function readViewport(leaf: WorkspaceLeaf | null): ExcalidrawViewport | null {
	const s = readViewState(leaf);
	return s ? { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom } : null;
}

/** Pushes a camera (scroll + zoom) onto a leaf's Excalidraw view. Returns false if unavailable. */
export function applyViewport(leaf: WorkspaceLeaf | null, vp: ExcalidrawViewport): boolean {
	const api = getExcalidrawApi(leaf);
	if (!api) return false;
	try {
		return updateExcalidrawScene(leaf, {
			...api.getAppState(),
			scrollX: vp.scrollX,
			scrollY: vp.scrollY,
			zoom: { value: vp.zoom },
		});
	} catch {
		return false;
	}
}

/** Enables Excalidraw's own Zen Mode for a Popout view once its API is live. */
export function enableZenMode(leaf: WorkspaceLeaf | null): boolean {
	const api = getExcalidrawApi(leaf);
	if (!api) return false;
	try {
		if (api.getAppState().zenModeEnabled === true) return true;
		return updateExcalidrawScene(leaf, { zenModeEnabled: true });
	} catch {
		return false;
	}
}

/**
 * Switches the Popout's box-selection to "overlap" (select anything the drag
 * rectangle touches) instead of Excalidraw's default "contain" (must fully
 * enclose) — the PureRef-style behavior. `boxSelectionMode` is a live appState
 * field in current Excalidraw (packages/element/src/selection.ts reads it, the
 * "Select on: Wrap/Overlap" menu flips it); on an older bundled Excalidraw that
 * lacks it, updateScene simply ignores the unknown key, so this degrades to a
 * no-op rather than breaking. Idempotent, mirrors enableZenMode.
 */
export function enableOverlapSelection(leaf: WorkspaceLeaf | null): boolean {
	const api = getExcalidrawApi(leaf);
	if (!api) return false;
	try {
		if (api.getAppState().boxSelectionMode === "overlap") return true;
		return updateExcalidrawScene(leaf, { boxSelectionMode: "overlap" });
	} catch {
		return false;
	}
}

/**
 * The main-window Excalidraw view's camera for a file, used to seed the Popout on
 * its first launch (per the "mirror on first launch, then persist" decision).
 * Only the main window is considered — Popouts (a different `ownerDocument`) are
 * skipped so we never mirror a Popout off itself.
 */
export function readMainWindowViewportForFile(app: App, filePath: string): ExcalidrawViewState | null {
	let result: ExcalidrawViewState | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (result || !isExcalidrawLeaf(leaf)) return;
		const view = leaf.view as unknown as { file?: TFile; containerEl?: HTMLElement };
		if (view.file?.path !== filePath) return;
		if (view.containerEl?.ownerDocument !== document) return;
		result = readViewState(leaf);
	});
	return result;
}

/**
 * Given the source view's camera and the Popout's own container size, produce the
 * camera that frames the same scene point at the same zoom. Excalidraw's transform
 * is `viewportPx = (scene + scroll) * zoom`, so matching the *center* (not the
 * top-left) across two differently-sized windows shifts scroll by half the size
 * delta in scene units.
 */
export function mirrorViewport(
	source: ExcalidrawViewState,
	targetWidth: number,
	targetHeight: number,
): ExcalidrawViewport {
	const zoom = source.zoom || 1;
	return {
		zoom,
		scrollX: source.scrollX + (targetWidth - source.width) / (2 * zoom),
		scrollY: source.scrollY + (targetHeight - source.height) / (2 * zoom),
	};
}

/** Reads the Popout's own current container size (for mirror math after it has mounted). */
export function readContainerSize(leaf: WorkspaceLeaf | null): { width: number; height: number } | null {
	const s = readViewState(leaf);
	return s ? { width: s.width, height: s.height } : null;
}

/** Excalidraw has mounted its imperative interface and measured a usable view. */
export function isCanvasReady(leaf: WorkspaceLeaf | null): boolean {
	const size = readContainerSize(leaf);
	return size !== null && size.width > 0 && size.height > 0;
}

/**
 * A size-independent camera: the scene coordinate at the center of the view,
 * plus zoom. This is the interchange used to keep the editable popout and the
 * read-only transparent window framed identically across a mode switch — each
 * side converts to/from it using its own view size, so the same scene point
 * stays centered at the same zoom even though the two windows differ slightly.
 *
 * Excalidraw's transform is `viewportPx = (scene + scroll) * zoom`, so the
 * scene point at container-center W/2 is `W/(2*zoom) - scroll`.
 */
export interface SceneView {
	cx: number;
	cy: number;
	zoom: number;
}

/** The leaf's non-deleted scene elements, for bounding-box math. Null if unavailable. */
export function readSceneElements(leaf: WorkspaceLeaf | null): readonly unknown[] | null {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return null;
	try {
		return api.getSceneElements().filter((el) => !el.isDeleted);
	} catch {
		return null;
	}
}

/**
 * Small gap left between packed elements, in scene units. Kept modest so packed
 * references sit close (PureRef-tight) without touching. Tunable; could become a
 * setting later.
 */
const PACK_GAP = 8;

/** A pseudo-random 31-bit integer for an element's versionNonce (mirrors Excalidraw). */
function randomVersionNonce(): number {
	return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * Shared plumbing for the PureRef arranges: read the selected, packable elements
 * (images/embeds/text — never drawings, shapes, arrows, or bound text), hand
 * them to a planner, and write the resulting moves back as one undoable history
 * entry. Positions only: nothing is resized or rotated. Returns false (a no-op)
 * when fewer than two packable elements are selected or the plan is empty, so the
 * caller can let Excalidraw's own key handling proceed instead.
 */
function applyPack(
	leaf: WorkspaceLeaf | null,
	plan: (selected: PackElement[]) => PackMove[],
): boolean {
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	try {
		all = api.getSceneElements();
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return false;
	}

	const selected = all.filter((el) => selectedIds[el.id] && isPackable(el));
	if (selected.length < 2) return false;

	const moves = plan(selected as PackElement[]);
	if (moves.length === 0) return false;

	const moveById = new Map(moves.map((m) => [m.id, m]));
	const nextElements = all.map((el) => {
		const move = moveById.get(el.id);
		if (!move) return el;
		return {
			...el,
			x: el.x + move.dx,
			y: el.y + move.dy,
			version: (el.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});

	try {
		// captureUpdate is the current key (CaptureUpdateAction.IMMEDIATELY);
		// commitToHistory is the older equivalent — harmless on newer builds — so
		// the move is a single Ctrl+Z step regardless of the bundled Excalidraw.
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
		return true;
	} catch {
		return false;
	}
}

/** A new axis-aligned box for one element, in scene coordinates. */
export interface ElementResize {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Rewrites the position/size of specific scene elements in one undoable step,
 * leaving every other element untouched. Used by the video aspect-ratio
 * corrector. Mirrors applyPack's version-bump + captureUpdate handling so the
 * change commits cleanly on any bundled Excalidraw. Returns false (no-op) if the
 * API is unavailable or none of the ids are present.
 */
export function resizeSceneElements(leaf: WorkspaceLeaf | null, resizes: readonly ElementResize[]): boolean {
	if (resizes.length === 0) return false;
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	try {
		all = api.getSceneElements();
	} catch {
		return false;
	}

	const byId = new Map(resizes.map((r) => [r.id, r]));
	let changed = false;
	const nextElements = all.map((el) => {
		const r = byId.get(el.id);
		if (!r) return el;
		changed = true;
		return {
			...el,
			x: r.x,
			y: r.y,
			width: r.width,
			height: r.height,
			version: (el.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});
	if (!changed) return false;

	try {
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Excalidraw's native image crop, stored in the *source image's* natural-pixel
 * space (pre-rotation, pre-flip). The renderer draws the sub-rect
 * `[x, y, width, height]` of the decoded bitmap — whose true size is
 * `naturalWidth × naturalHeight` — onto the element's on-canvas box, so these
 * values MUST be real decoded pixels (renderElement.ts drawImage). The element
 * keeps the full file; double-clicking re-exposes the whole thing.
 */
export interface ImageCrop {
	x: number;
	y: number;
	width: number;
	height: number;
	naturalWidth: number;
	naturalHeight: number;
}

/** The image-element fields the crop primitive reads. */
interface ImageSceneElement extends SceneElement {
	angle?: number;
	scale?: readonly [number, number];
	crop?: ImageCrop | null;
	fileId?: string;
}

/** An axis-aligned rectangle in scene coordinates. */
export interface SceneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A crop small enough to be treated as no crop (element back to full image). */
const CROP_RESET_EPSILON = 1;
/** Ignore a visible sliver thinner than this (scene units) — nothing to show. */
const MIN_CROP_SCENE = 1;

/** Whether an element is a live (non-deleted) Excalidraw image. */
function isImageElement(el: SceneElement): el is ImageSceneElement {
	return el.type === "image" && !el.isDeleted;
}

/**
 * Decodes an image's natural pixel size from its dataURL, memoized per fileId so
 * a multi-image crop decodes each source at most once. Resolves null on failure.
 */
function makeNaturalSizeResolver(win: Window, files: Record<string, { dataURL?: string } | undefined>) {
	const cache = new Map<string, Promise<{ w: number; h: number } | null>>();
	return (fileId: string): Promise<{ w: number; h: number } | null> => {
		const hit = cache.get(fileId);
		if (hit) return hit;
		const dataURL = files[fileId]?.dataURL;
		const promise: Promise<{ w: number; h: number } | null> = !dataURL
			? Promise.resolve(null)
			: new Promise((resolve) => {
					const img = win.document.createElement("img");
					img.onload = () =>
						resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
					img.onerror = () => resolve(null);
					img.src = dataURL;
				});
		cache.set(fileId, promise);
		return promise;
	};
}

/**
 * Computes the new geometry + `crop` for one upright image so its visible region
 * becomes the intersection of its *current visible* rect with `rect` (both in
 * scene coords). Composes with any existing crop and with horizontal/vertical
 * flips (`scale === -1`), which store the crop origin from the opposite edge.
 *
 * Crop only ever *removes*: the result is clamped to what's currently shown, so a
 * rect reaching past the current crop never re-adds already-hidden pixels
 * (Excalidraw's own double-click remains the way to re-expose the full original).
 *
 * Returns null when the element is rotated (`angle` set — deferred; see the crop
 * design notes), when the rect misses the current visible region, or when the
 * sliver is degenerate. When an *uncropped* image is fully covered the result
 * stays uncropped (crop null) rather than gaining a redundant full crop.
 */
function planImageCrop(
	el: ImageSceneElement,
	rect: SceneRect,
	natural: { w: number; h: number },
): { x: number; y: number; width: number; height: number; crop: ImageCrop | null } | null {
	// Rotation is deferred: a screen-aligned rect maps to a rotated quad in image
	// space, which the axis-aligned `crop` rect can't represent. Skip such images.
	if (el.angle && Math.abs(el.angle) > 1e-6) return null;

	const nw = natural.w;
	const nh = natural.h;
	const crop = el.crop ?? null;
	const flipX = el.scale?.[0] === -1;
	const flipY = el.scale?.[1] === -1;

	// On-canvas size of the *uncropped* image at this element's current scale.
	const uncroppedW = crop ? el.width / (crop.width / crop.naturalWidth) : el.width;
	const uncroppedH = crop ? el.height / (crop.height / crop.naturalHeight) : el.height;
	if (uncroppedW <= 0 || uncroppedH <= 0) return null;

	const natPerCanvasX = nw / uncroppedW;
	const natPerCanvasY = nh / uncroppedH;

	// Current visible crop origin as seen on screen (undo the flip storage), in
	// natural px → convert to canvas px to locate the uncropped image's top-left.
	const visualCropX = crop ? (flipX ? nw - crop.width - crop.x : crop.x) : 0;
	const visualCropY = crop ? (flipY ? nh - crop.height - crop.y : crop.y) : 0;
	const uncroppedX = el.x - visualCropX / natPerCanvasX;
	const uncroppedY = el.y - visualCropY / natPerCanvasY;

	// Intersect the drag rect with the CURRENT VISIBLE box (the element's own
	// on-canvas rect), not the uncropped image — so a crop can only shrink the
	// visible region, never re-add pixels an earlier crop removed.
	const vx = Math.max(rect.x, el.x);
	const vy = Math.max(rect.y, el.y);
	const vRight = Math.min(rect.x + rect.width, el.x + el.width);
	const vBottom = Math.min(rect.y + rect.height, el.y + el.height);
	const vw = vRight - vx;
	const vh = vBottom - vy;
	if (vw < MIN_CROP_SCENE || vh < MIN_CROP_SCENE) return null;

	// Visible sub-rect back into natural px (screen/visual space, pre-flip).
	const visW = vw * natPerCanvasX;
	const visH = vh * natPerCanvasY;
	const visX = (vx - uncroppedX) * natPerCanvasX;
	const visY = (vy - uncroppedY) * natPerCanvasY;

	// Full coverage → uncrop.
	if (Math.abs(visX) < CROP_RESET_EPSILON && Math.abs(visY) < CROP_RESET_EPSILON && Math.abs(visW - nw) < CROP_RESET_EPSILON && Math.abs(visH - nh) < CROP_RESET_EPSILON) {
		return { x: vx, y: vy, width: vw, height: vh, crop: null };
	}

	// Re-apply flip storage (crop origin measured from the opposite edge).
	const nextCrop: ImageCrop = {
		x: flipX ? nw - visW - visX : visX,
		y: flipY ? nh - visH - visY : visY,
		width: visW,
		height: visH,
		naturalWidth: nw,
		naturalHeight: nh,
	};
	return { x: vx, y: vy, width: vw, height: vh, crop: nextCrop };
}

/**
 * The active Excalidraw leaf: the focused leaf when it's an Excalidraw view, else
 * the first Excalidraw view anywhere (main window or a popout). Convenience for
 * command/debug entry points that don't have an event target to locate from.
 */
export function getActiveExcalidrawLeaf(app: App): WorkspaceLeaf | null {
	if (isExcalidrawLeaf(app.workspace.activeLeaf)) return app.workspace.activeLeaf;
	let first: WorkspaceLeaf | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (!first && isExcalidrawLeaf(leaf)) first = leaf;
	});
	return first;
}

/**
 * The union on-canvas bounding box (scene coords) of the currently-selected image
 * elements, or null if none are selected. Uses each element's rendered box, so a
 * rotated image contributes its unrotated box — fine for a debug proxy rect.
 */
export function getSelectedImageSceneBBox(leaf: WorkspaceLeaf | null): SceneRect | null {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return null;
	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	try {
		all = api.getSceneElements();
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return null;
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const el of all) {
		if (!isImageElement(el) || !selectedIds[el.id]) continue;
		minX = Math.min(minX, el.x);
		minY = Math.min(minY, el.y);
		maxX = Math.max(maxX, el.x + el.width);
		maxY = Math.max(maxY, el.y + el.height);
	}
	if (!Number.isFinite(minX)) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Converts a client (viewport-pixel) point in the leaf's window to scene
 * coordinates, using the exact transform Excalidraw uses internally
 * (`scene = (client - offset) / zoom - scroll`). Returns null if unavailable.
 */
export function clientToSceneCoords(leaf: WorkspaceLeaf | null, clientX: number, clientY: number): { x: number; y: number } | null {
	const api = getExcalidrawApi(leaf);
	if (!api) return null;
	try {
		const s = api.getAppState();
		const zoom = s.zoom?.value || 1;
		return {
			x: (clientX - (s.offsetLeft ?? 0)) / zoom - s.scrollX,
			y: (clientY - (s.offsetTop ?? 0)) / zoom - s.scrollY,
		};
	} catch {
		return null;
	}
}

/** Ids of the leaf's image elements — the selected ones, or all when `selectedOnly` is false. */
export function getImageIds(leaf: WorkspaceLeaf | null, selectedOnly: boolean): string[] {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return [];
	try {
		const all = api.getSceneElements();
		const selected = api.getAppState().selectedElementIds ?? {};
		return all.filter((el) => isImageElement(el) && (!selectedOnly || selected[el.id])).map((el) => el.id);
	} catch {
		return [];
	}
}

/** Outcome of a crop request, for debugging and caller feedback. */
export interface CropResult {
	cropped: string[];
	/** Ids skipped: rotated, missed by the rect, degenerate, or size-unknown. */
	skipped: string[];
}

/**
 * The reusable crop primitive: crop every target image so its visible region is
 * the part of it inside `rect` (scene coords). Targets `ids` when given, else the
 * current image selection. Upright and flipped images crop exactly; rotated ones
 * are skipped (deferred). Writes all changes as one undoable step. Async because
 * uncropped images must decode to learn their true natural size (cropped images
 * already carry it in `crop.naturalWidth/Height`).
 */
export async function cropImagesToSceneRect(
	leaf: WorkspaceLeaf | null,
	rect: SceneRect,
	ids?: readonly string[],
): Promise<CropResult> {
	const result: CropResult = { cropped: [], skipped: [] };
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return result;

	let all: readonly SceneElement[];
	let files: Record<string, { dataURL?: string } | undefined>;
	let selectedIds: Record<string, boolean>;
	try {
		all = api.getSceneElements();
		files = api.getFiles?.() ?? {};
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return result;
	}

	const idSet = ids ? new Set(ids) : null;
	const targets = all.filter(
		(el): el is ImageSceneElement => isImageElement(el) && (idSet ? idSet.has(el.id) : !!selectedIds[el.id]),
	);
	if (targets.length === 0) return result;

	const win = view.containerEl?.ownerDocument?.defaultView ?? window;
	const naturalSizeOf = makeNaturalSizeResolver(win, files);

	// Resolve each target's natural size (cropped: free; uncropped: decode), then plan.
	const plans = new Map<string, { x: number; y: number; width: number; height: number; crop: ImageCrop | null }>();
	await Promise.all(
		targets.map(async (el) => {
			const natural = el.crop
				? { w: el.crop.naturalWidth, h: el.crop.naturalHeight }
				: el.fileId
					? await naturalSizeOf(el.fileId)
					: null;
			if (!natural) {
				result.skipped.push(el.id);
				return;
			}
			const plan = planImageCrop(el, rect, natural);
			if (!plan) {
				result.skipped.push(el.id);
				return;
			}
			plans.set(el.id, plan);
		}),
	);
	if (plans.size === 0) return result;

	const nextElements = all.map((el) => {
		const plan = plans.get(el.id);
		if (!plan) return el;
		result.cropped.push(el.id);
		return {
			...el,
			x: plan.x,
			y: plan.y,
			width: plan.width,
			height: plan.height,
			crop: plan.crop,
			version: (el.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});

	try {
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
	} catch {
		return { cropped: [], skipped: targets.map((t) => t.id) };
	}
	return result;
}

/**
 * Clears the `crop` on target images, restoring each to its full original at the
 * right on-canvas position/size — the inverse of cropImagesToSceneRect and the
 * programmatic equivalent of Excalidraw's double-click uncrop. Targets `ids` when
 * given, else the current image selection. Upright and flipped images restore
 * exactly; rotated ones are skipped (use the native double-click for those).
 * Synchronous: natural size comes from the existing crop, so nothing is decoded.
 */
export function uncropImages(leaf: WorkspaceLeaf | null, ids?: readonly string[]): string[] {
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return [];

	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	try {
		all = api.getSceneElements();
		selectedIds = api.getAppState().selectedElementIds ?? {};
	} catch {
		return [];
	}

	const idSet = ids ? new Set(ids) : null;
	const uncropped: string[] = [];
	const nextElements = all.map((raw) => {
		if (!isImageElement(raw)) return raw;
		const el = raw;
		const target = idSet ? idSet.has(el.id) : !!selectedIds[el.id];
		if (!target || !el.crop) return raw;
		if (el.angle && Math.abs(el.angle) > 1e-6) return raw; // native double-click handles rotated

		const crop = el.crop;
		const flipX = el.scale?.[0] === -1;
		const flipY = el.scale?.[1] === -1;
		const uncroppedW = el.width / (crop.width / crop.naturalWidth);
		const uncroppedH = el.height / (crop.height / crop.naturalHeight);
		const visualCropX = flipX ? crop.naturalWidth - crop.width - crop.x : crop.x;
		const visualCropY = flipY ? crop.naturalHeight - crop.height - crop.y : crop.y;
		uncropped.push(el.id);
		return {
			...el,
			x: el.x - (visualCropX / crop.naturalWidth) * uncroppedW,
			y: el.y - (visualCropY / crop.naturalHeight) * uncroppedH,
			width: uncroppedW,
			height: uncroppedH,
			crop: null,
			version: (el.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});
	if (uncropped.length === 0) return [];

	try {
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
	} catch {
		return [];
	}
	return uncropped;
}

/**
 * PureRef-style Ctrl+Arrow gravity pack: settle the selection toward `direction`.
 * See applyPack for the no-op contract (lets Excalidraw's arrow-nudge proceed).
 */
export function packSelectedElements(leaf: WorkspaceLeaf | null, direction: PackDirection): boolean {
	return applyPack(leaf, (selected) => planPack(selected, direction, PACK_GAP));
}

/**
 * PureRef-style Ctrl+Shift+P "Optimal" arrange: re-lay the selection into a
 * compact, roughly-square, top-left-anchored block. See applyPack for the no-op
 * contract.
 */
export function optimalPackSelectedElements(leaf: WorkspaceLeaf | null): boolean {
	return applyPack(leaf, (selected) => planOptimalPack(selected, PACK_GAP));
}

/**
 * Finds the Excalidraw leaf a keyboard event belongs to. Prefers the leaf whose
 * container actually contains the event target (correct when several Excalidraw
 * views share the main window); falls back to the only Excalidraw view in the
 * event's document (the usual Popout case, where focus sits on the window body).
 */
export function findExcalidrawLeafForNode(app: App, node: Node | null): WorkspaceLeaf | null {
	const doc = node?.ownerDocument ?? null;
	let containing: WorkspaceLeaf | null = null;
	let sameDoc: WorkspaceLeaf | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (containing || !isExcalidrawLeaf(leaf)) return;
		const container = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
		if (!container) return;
		if (node && container.contains(node)) {
			containing = leaf;
		} else if (doc && !sameDoc && container.ownerDocument === doc) {
			sameDoc = leaf;
		}
	});
	return containing ?? sameDoc;
}

/** The popout leaf's current camera as a SceneView, or null if unavailable. */
export function readSceneView(leaf: WorkspaceLeaf | null): SceneView | null {
	const s = readViewState(leaf);
	if (!s) return null;
	const zoom = s.zoom || 1;
	return {
		cx: s.width / (2 * zoom) - s.scrollX,
		cy: s.height / (2 * zoom) - s.scrollY,
		zoom,
	};
}

/** Applies a SceneView to the popout leaf, re-centered for its own container size. */
export function applySceneView(leaf: WorkspaceLeaf | null, view: SceneView): boolean {
	const size = readContainerSize(leaf);
	if (!size) return false;
	const zoom = view.zoom || 1;
	return applyViewport(leaf, {
		zoom,
		scrollX: size.width / (2 * zoom) - view.cx,
		scrollY: size.height / (2 * zoom) - view.cy,
	});
}
