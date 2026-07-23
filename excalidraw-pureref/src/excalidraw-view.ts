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
	opacity?: number;
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
		gridSize?: number;
	};
	getSceneElements?(): readonly SceneElement[];
	/** The scene's binary files, keyed by an image element's `fileId`. */
	getFiles?(): Record<string, { dataURL?: string } | undefined>;
	addFiles?(files: readonly unknown[]): void;
	updateScene?(scene: {
		elements?: readonly unknown[];
		files?: Record<string, { dataURL?: string } | undefined>;
		captureUpdate?: string;
	}): void;
}

interface ExcalidrawEmbeddedFileLike {
	getImage?(isDark: boolean): string;
	setImage?(image: {
		imgBase64: string;
		mimeType: string;
		size: { width: number; height: number };
		isDark: boolean;
		isSVGwithBitmap: boolean;
		pdfPageViewProps: null;
		renderScale: number;
	}): void;
	file?: TFile | null;
	linkParts?: { path?: string; original?: string };
}

interface ExcalidrawDataLike {
	getFile?(fileId: string): ExcalidrawEmbeddedFileLike | undefined;
	setFile?(fileId: string, file: unknown): void;
	deleteFile?(fileId: string): void;
}

interface ExcalidrawViewLike {
	containerEl?: HTMLElement;
	file?: TFile;
	_plugin?: unknown;
	excalidrawData?: ExcalidrawDataLike;
	excalidrawAPI?: ExcalidrawApi;
	updateScene?(scene: {
		elements?: readonly unknown[];
		files?: Record<string, { dataURL?: string } | undefined>;
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

function getExcalidrawData(leaf: WorkspaceLeaf | null): ExcalidrawDataLike | null {
	return getExcalidrawView(leaf)?.excalidrawData ?? null;
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
 * Fallback gap between packed elements, in scene units, for when Excalidraw's
 * app state doesn't expose a grid size. Matches Excalidraw's own default grid
 * size (DEFAULT_GRID_SIZE in packages/common/src/constants.ts).
 */
const DEFAULT_PACK_GAP = 20;

/** The same ten-percent increment used by Excalidraw's opacity control. */
const ELEMENT_OPACITY_STEP = 10;

/** A pseudo-random 31-bit integer for an element's versionNonce (mirrors Excalidraw). */
function randomVersionNonce(): number {
	return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * Changes every currently selected scene element's opacity in one undoable
 * history entry. A false return means there was no concrete element selection,
 * so callers can leave a window-level Ctrl+plus/minus command untouched.
 */
export function adjustSelectedElementsOpacity(leaf: WorkspaceLeaf | null, direction: -1 | 1): boolean {
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

	let selected = false;
	const nextElements = all.map((el) => {
		if (!selectedIds[el.id] || el.isDeleted) return el;
		selected = true;
		return {
			...el,
			opacity: Math.max(0, Math.min(100, (el.opacity ?? 100) + direction * ELEMENT_OPACITY_STEP)),
			version: (el.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});
	if (!selected) return false;

	try {
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
		return true;
	} catch {
		return false;
	}
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
	plan: (selected: PackElement[], gap: number) => PackMove[],
): boolean {
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	let gap: number;
	try {
		all = api.getSceneElements();
		const appState = api.getAppState();
		selectedIds = appState.selectedElementIds ?? {};
		gap = appState.gridSize ?? DEFAULT_PACK_GAP;
	} catch {
		return false;
	}

	const selected = all.filter((el) => selectedIds[el.id] && isPackable(el));
	if (selected.length < 2) return false;

	const moves = plan(selected as PackElement[], gap);
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

/** The mutable geometry needed for a modal selection transform. */
export interface TransformElement {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	angle: number;
}

/** Returns a stable snapshot of the current selection's transformable elements. */
export function getSelectedTransformElements(leaf: WorkspaceLeaf | null): TransformElement[] {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return [];
	try {
		const selectedIds = api.getAppState().selectedElementIds ?? {};
		return api.getSceneElements().flatMap((element) => {
			if (!selectedIds[element.id] || element.isDeleted) return [];
			return [{
				id: element.id,
				x: element.x,
				y: element.y,
				width: element.width,
				height: element.height,
				angle: element.angle ?? 0,
			}];
		});
	} catch {
		return [];
	}
}

/**
 * Applies a modal-transform preview or final result. Preview updates are kept
 * out of history; the final identical update is captured as one undo step.
 */
export function applySelectionTransform(
	leaf: WorkspaceLeaf | null,
	transforms: readonly TransformElement[],
	captureUpdate: "NEVER" | "IMMEDIATELY",
): boolean {
	if (transforms.length === 0) return false;
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	try {
		all = api.getSceneElements();
	} catch {
		return false;
	}
	const byId = new Map(transforms.map((transform) => [transform.id, transform]));
	let changed = false;
	const nextElements = all.map((element) => {
		const transform = byId.get(element.id);
		if (!transform) return element;
		changed = true;
		return {
			...element,
			x: transform.x,
			y: transform.y,
			width: transform.width,
			height: transform.height,
			angle: transform.angle,
			version: (element.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});
	if (!changed) return false;

	try {
		view.updateScene({
			elements: nextElements,
			captureUpdate,
			commitToHistory: captureUpdate === "IMMEDIATELY",
		});
		return true;
	} catch {
		return false;
	}
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

export type ImageFlipAxis = "horizontal" | "vertical";

/** The image-element fields the crop primitive reads. */
interface ImageSceneElement extends SceneElement {
	versionNonce?: number;
	angle?: number;
	scale?: readonly [number, number];
	crop?: ImageCrop | null;
	fileId?: string;
	customData?: Record<string, unknown>;
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

/** A size this close to the target is already reset — leave it alone. */
const SCALE_RESET_EPSILON = 0.01;

/**
 * Clears every selected element's rotation (Blender's Alt+R). Excalidraw rotates
 * an element about the centre of its unrotated box, so dropping `angle` to 0
 * leaves x/y/width/height — and therefore the centre — exactly where they are.
 * Returns false when nothing is selected or everything is already upright, so a
 * caller can leave the keystroke unconsumed.
 */
export function resetSelectedRotation(leaf: WorkspaceLeaf | null): boolean {
	const rotated = getSelectedTransformElements(leaf).filter((element) => element.angle !== 0);
	if (rotated.length === 0) return false;
	return applySelectionTransform(
		leaf,
		rotated.map((element) => ({ ...element, angle: 0 })),
		"IMMEDIATELY",
	);
}

/**
 * Resets every selected image to 100% scale — its native pixel size (Blender's
 * Alt+S), the same size the plugin imports at, so a reset image lines up 1:1
 * with freshly imported ones again.
 *
 * A natively cropped image resets to its *visible* crop measured in natural
 * pixels, never the whole file, so the reset cannot re-expose cropped-away
 * content (that stays Excalidraw's double-click uncrop). Rotation and flips
 * (`scale: [-1, 1]`) are deliberately preserved — this restores size only —
 * and each image resizes about its own centre. One undoable step.
 *
 * Returns false when the selection holds no image that needs resizing.
 */
export async function resetSelectedImageScale(leaf: WorkspaceLeaf | null): Promise<boolean> {
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !api.getFiles || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	let files: Record<string, { dataURL?: string } | undefined>;
	try {
		all = api.getSceneElements();
		selectedIds = api.getAppState().selectedElementIds ?? {};
		files = api.getFiles();
	} catch {
		return false;
	}

	const targets = all.filter((el): el is ImageSceneElement => isImageElement(el) && !!selectedIds[el.id]);
	if (targets.length === 0) return false;

	const win = view.containerEl?.ownerDocument?.defaultView ?? window;
	const naturalSizeOf = makeNaturalSizeResolver(win, files);

	const transforms: TransformElement[] = [];
	for (const el of targets) {
		// A native crop already records its visible size in natural pixels, so only
		// an uncropped image needs its file decoded.
		const target = el.crop
			? { w: el.crop.width, h: el.crop.height }
			: el.fileId
				? await naturalSizeOf(el.fileId)
				: null;
		if (!target || target.w <= 0 || target.h <= 0) continue;
		if (
			Math.abs(el.width - target.w) <= SCALE_RESET_EPSILON * target.w &&
			Math.abs(el.height - target.h) <= SCALE_RESET_EPSILON * target.h
		) {
			continue; // already at 100%
		}
		const cx = el.x + el.width / 2;
		const cy = el.y + el.height / 2;
		transforms.push({
			id: el.id,
			x: cx - target.w / 2,
			y: cy - target.h / 2,
			width: target.w,
			height: target.h,
			angle: el.angle ?? 0,
		});
	}
	if (transforms.length === 0) return false;
	return applySelectionTransform(leaf, transforms, "IMMEDIATELY");
}

interface CropPoint {
	x: number;
	y: number;
}

interface AffineTransform {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

/** Persisted state for the PureRef-style crop layer. */
interface ViewportCropState {
	version: 1;
	sourceFileId: string;
	sourcePath?: string;
	sourceNaturalWidth: number;
	sourceNaturalHeight: number;
	/** The Excalidraw crop that existed before the custom layer was created. */
	baseCrop: ImageCrop | null;
	/** Source natural pixels → the current generated image's local pixels. */
	sourceToLocal: AffineTransform;
	/** The visible polygon in the current generated image's local pixels. */
	polygon: CropPoint[];
	/** Vault path of the generated PNG used by the current image element. */
	generatedPath: string;
}

const VIEWPORT_CROP_KEY = "excalidrawPureRefViewportCrop";

function getViewportCropState(el: ImageSceneElement): ViewportCropState | null {
	const value = el.customData?.[VIEWPORT_CROP_KEY];
	if (!value || typeof value !== "object") return null;
	const state = value as Partial<ViewportCropState>;
	if (state.version !== 1 || typeof state.sourceFileId !== "string" || !Array.isArray(state.polygon)) return null;
	if (!state.sourceToLocal || typeof state.sourceToLocal.a !== "number") return null;
	return state as ViewportCropState;
}

function multiplyAffine(left: AffineTransform, right: AffineTransform): AffineTransform {
	return {
		a: left.a * right.a + left.c * right.b,
		b: left.b * right.a + left.d * right.b,
		c: left.a * right.c + left.c * right.d,
		d: left.b * right.c + left.d * right.d,
		e: left.a * right.e + left.c * right.f + left.e,
		f: left.b * right.e + left.d * right.f + left.f,
	};
}

function applyAffine(transform: AffineTransform, point: CropPoint): CropPoint {
	return {
		x: transform.a * point.x + transform.c * point.y + transform.e,
		y: transform.b * point.x + transform.d * point.y + transform.f,
	};
}

function invertAffine(transform: AffineTransform): AffineTransform | null {
	const det = transform.a * transform.d - transform.b * transform.c;
	if (Math.abs(det) < 1e-9) return null;
	const a = transform.d / det;
	const b = -transform.b / det;
	const c = -transform.c / det;
	const d = transform.a / det;
	return {
		a,
		b,
		c,
		d,
		e: -(a * transform.e + c * transform.f),
		f: -(b * transform.e + d * transform.f),
	};
}

/** Maps the image element's local pixels to scene coordinates. */
function elementLocalToScene(el: ImageSceneElement): AffineTransform {
	const angle = el.angle ?? 0;
	const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		a: cos,
		b: sin,
		c: -sin,
		d: cos,
		e: center.x - cos * el.width / 2 + sin * el.height / 2,
		f: center.y - sin * el.width / 2 - cos * el.height / 2,
	};
}

function sceneRectPolygon(rect: SceneRect): CropPoint[] {
	return [
		{ x: rect.x, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y + rect.height },
		{ x: rect.x, y: rect.y + rect.height },
	];
}

/** Sutherland–Hodgman clipping for convex polygons. */
function intersectConvexPolygons(subject: readonly CropPoint[], clip: readonly CropPoint[]): CropPoint[] {
	let output = [...subject];
	if (output.length < 3 || clip.length < 3) return [];
	const signedArea = clip.reduce((sum, p, i) => {
		const next = clip[(i + 1) % clip.length];
		return sum + p.x * next.y - next.x * p.y;
	}, 0);
	const orientation = signedArea >= 0 ? 1 : -1;
	const inside = (p: CropPoint, a: CropPoint, b: CropPoint) =>
		orientation * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= -1e-7;
	const intersection = (p: CropPoint, q: CropPoint, a: CropPoint, b: CropPoint): CropPoint => {
		const dx = q.x - p.x;
		const dy = q.y - p.y;
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const denominator = dx * ey - dy * ex;
		if (Math.abs(denominator) < 1e-9) return q;
		const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / denominator;
		return { x: p.x + t * dx, y: p.y + t * dy };
	};
	for (let i = 0; i < clip.length && output.length; i++) {
		const a = clip[i];
		const b = clip[(i + 1) % clip.length];
		const input = output;
		output = [];
		let previous = input[input.length - 1];
		for (const current of input) {
			const currentInside = inside(current, a, b);
			const previousInside = inside(previous, a, b);
			if (currentInside !== previousInside) output.push(intersection(previous, current, a, b));
			if (currentInside) output.push(current);
			previous = current;
		}
	}
	return output;
}

function pointInsideConvexPolygon(point: CropPoint, polygon: readonly CropPoint[]): boolean {
	if (polygon.length < 3) return false;
	const signedArea = polygon.reduce((sum, p, i) => {
		const next = polygon[(i + 1) % polygon.length];
		return sum + p.x * next.y - next.x * p.y;
	}, 0);
	const orientation = signedArea >= 0 ? 1 : -1;
	return polygon.every((a, i) => {
		const b = polygon[(i + 1) % polygon.length];
		return orientation * ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) >= -1e-6;
	});
}

function polygonBounds(polygon: readonly CropPoint[]): SceneRect | null {
	if (polygon.length < 3) return null;
	const xs = polygon.map((p) => p.x);
	const ys = polygon.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function sourceContainsExcalidrawDarkFilter(dataURL: string): boolean {
	if (!/^data:image\/svg\+xml/i.test(dataURL)) return false;
	try {
		const comma = dataURL.indexOf(",");
		if (comma < 0) return false;
		const payload = dataURL.slice(comma + 1);
		const svg = /;base64/i.test(dataURL) ? atob(payload) : decodeURIComponent(payload);
		return svg.includes("invert(100%)") && svg.includes("hue-rotate(180deg)");
	} catch {
		return false;
	}
}

function nextViewportFileId(): string {
	// Obsidian Excalidraw serializes embedded-file IDs with /[\w\d]*/. Hyphens
	// silently prevent the entry from being parsed back after the background
	// save, leaving the element alive while its core binary disappears.
	return `eprviewport${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function nextViewportPath(app: App, leaf: WorkspaceLeaf | null, elementId: string, sourcePath?: string): string {
	// Keep the disposable crop beside its source. Falling back to the drawing is
	// only for non-vault/legacy images whose source path cannot be recovered.
	const sourceSlash = sourcePath?.lastIndexOf("/") ?? -1;
	const folder = sourcePath !== undefined
		? (sourceSlash >= 0 ? sourcePath.slice(0, sourceSlash) : "")
		: (getExcalidrawFileForLeaf(leaf)?.parent?.path ?? "");
	// Do not dot-prefix this attachment. Obsidian excludes dotfiles from the
	// vault index, which makes a successfully written PNG invisible to both the
	// Files view and Excalidraw's path resolver.
	const stem = `epr-viewport-${elementId}`;
	let path = folder ? `${folder}/${stem}.png` : `${stem}.png`;
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(path)) {
		path = folder ? `${folder}/${stem}-${suffix}.png` : `${stem}-${suffix}.png`;
		suffix++;
	}
	return path;
}

interface GeneratedViewportFileRef {
	fileId: string;
	path: string;
}

/**
 * Remove generated files only after Excalidraw has observed the replacement
 * fileId. updateScene schedules React work, so deleting in the same call stack
 * can make the old image loader race the vault deletion and emit a false
 * "could not find image file" warning.
 */
async function deleteDetachedViewportFiles(
	app: App,
	leaf: WorkspaceLeaf | null,
	files: readonly GeneratedViewportFileRef[],
): Promise<void> {
	if (files.length === 0) return;
	const api = getExcalidrawApi(leaf);
	const win = getExcalidrawView(leaf)?.containerEl?.ownerDocument?.defaultView ?? window;
	let pending = [...files];
	for (let attempt = 0; attempt < 20 && pending.length; attempt++) {
		// Always cross at least one task boundary so the scene swap renders first.
		await new Promise<void>((resolve) => win.setTimeout(resolve, 50));
		let referenced = new Set<string>();
		try {
			referenced = new Set(
				(api?.getSceneElements?.() ?? [])
					.filter(isImageElement)
					.map((element) => element.fileId)
					.filter((fileId): fileId is string => !!fileId),
			);
		} catch {
			continue;
		}
		const detached = pending.filter((file) => !referenced.has(file.fileId));
		pending = pending.filter((file) => referenced.has(file.fileId));
		for (const file of detached) {
			getExcalidrawData(leaf)?.deleteFile?.(file.fileId);
			const generated = app.vault.getAbstractFileByPath(file.path);
			if (generated) {
				try {
					await app.vault.delete(generated);
				} catch {
					// The scene already points at the source. A failed best-effort
					// cleanup may leave an orphan, but must not break cancel/uncrop.
				}
			} else if (await app.vault.adapter.exists(file.path)) {
				// Compatibility cleanup for crops made by older builds. Those used
				// dot-prefixed names, so Obsidian never created a TFile for them.
				try {
					await app.vault.adapter.remove(file.path);
				} catch {
					// Same best-effort cleanup contract as the indexed path above.
				}
			}
		}
	}
}

/**
 * Registers a generated PNG with Obsidian Excalidraw's vault-backed file map.
 * The core Excalidraw API only keeps a session-local BinaryFileData entry;
 * Obsidian's reload path resolves fileIds through ExcalidrawData/filesMaster.
 */
function registerViewportFile(
	leaf: WorkspaceLeaf | null,
	sourceFileId: string,
	generatedFileId: string,
	path: string,
	dataURL: string,
	size: { width: number; height: number },
): boolean {
	const view = getExcalidrawView(leaf);
	const data = view?.excalidrawData;
	const plugin = view?._plugin;
	if (!data?.setFile || !plugin) return false;
	try {
		const source = sourceFileId ? data.getFile?.(sourceFileId) : undefined;
		const EmbeddedFileConstructor = source && (source as unknown as { constructor?: new (...args: unknown[]) => unknown }).constructor;
		if (!EmbeddedFileConstructor) return false;
		const drawingPath = view.file?.path ?? "";
		// createBinary has already inserted this normal (non-dotfile) path into the
		// vault index, so construct the exact record Excalidraw expects for it.
		const embedded = new EmbeddedFileConstructor(plugin, drawingPath, path);
		const generated = embedded as ExcalidrawEmbeddedFileLike;
		if (!generated.file || typeof generated.setImage !== "function") return false;
		// Merely associating the TFile leaves EmbeddedFile at its defaults
		// (application/octet-stream, 0x0, empty img). That record is what the
		// Obsidian Excalidraw loader reads, even when core getFiles() is valid.
		generated.setImage({
			imgBase64: dataURL,
			mimeType: "image/png",
			size,
			isDark: false,
			isSVGwithBitmap: false,
			pdfPageViewProps: null,
			renderScale: 0,
		});
		data.setFile(generatedFileId, embedded);
		return true;
	} catch {
		return false;
	}
}

function getSourceDataURL(leaf: WorkspaceLeaf | null, files: Record<string, { dataURL?: string } | undefined>, fileId: string, isDark: boolean): string | null {
		const direct = files[fileId]?.dataURL;
		if (direct) return direct;
		try {
			return getExcalidrawData(leaf)?.getFile?.(fileId)?.getImage?.(isDark) ?? null;
		} catch {
			return null;
		}
}

function getSourcePath(leaf: WorkspaceLeaf | null, fileId: string): string | undefined {
	try {
		return getExcalidrawData(leaf)?.getFile?.(fileId)?.file?.path;
	} catch {
		return undefined;
	}
}

function loadCanvasImage(dataURL: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = window.document.createElement("img");
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Unable to decode source image for viewport crop"));
		image.src = dataURL;
	});
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Unable to encode viewport crop PNG"))), "image/png");
	});
}

async function renderViewportPng(
	dataURL: string,
	sourceWidth: number,
	sourceHeight: number,
	outputWidth: number,
	outputHeight: number,
	polygon: readonly CropPoint[],
	sourceToLocal: AffineTransform,
	sourceIsDarkThemed: boolean,
): Promise<{ dataURL: string; data: ArrayBuffer; width: number; height: number }> {
	const image = await loadCanvasImage(dataURL);
	const sourceScaleX = Math.hypot(sourceToLocal.a, sourceToLocal.b);
	const sourceScaleY = Math.hypot(sourceToLocal.c, sourceToLocal.d);
	const pixelDensity = Math.max(1, Math.min(4, 1 / Math.max(1e-6, Math.min(sourceScaleX, sourceScaleY))));
	const canvas = window.document.createElement("canvas");
	canvas.width = Math.max(1, Math.ceil(outputWidth * pixelDensity));
	canvas.height = Math.max(1, Math.ceil(outputHeight * pixelDensity));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Unable to create canvas context for viewport crop");

	context.save();
	context.scale(pixelDensity, pixelDensity);
	context.beginPath();
	polygon.forEach((point, index) => {
		if (index === 0) context.moveTo(point.x, point.y);
		else context.lineTo(point.x, point.y);
	});
	context.closePath();
	context.clip();
	if (sourceIsDarkThemed && sourceContainsExcalidrawDarkFilter(dataURL)) {
		context.filter = "saturate(0.8) hue-rotate(-180deg) invert(100%)";
	}
	context.setTransform(
		pixelDensity * sourceToLocal.a,
		pixelDensity * sourceToLocal.b,
		pixelDensity * sourceToLocal.c,
		pixelDensity * sourceToLocal.d,
		pixelDensity * sourceToLocal.e,
		pixelDensity * sourceToLocal.f,
	);
	context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
	context.restore();

	const blob = await canvasToBlob(canvas);
	const data = await blob.arrayBuffer();
	return { dataURL: canvas.toDataURL("image/png"), data, width: canvas.width, height: canvas.height };
}

/** Maps an image file's natural pixels into its *currently visible* local box. */
function filePixelsToCurrentLocal(el: ImageSceneElement, natural: { w: number; h: number }): AffineTransform {
	const crop = el.crop ?? { x: 0, y: 0, width: natural.w, height: natural.h, naturalWidth: natural.w, naturalHeight: natural.h };
	const flipX = el.scale?.[0] === -1;
	const flipY = el.scale?.[1] === -1;
	// Excalidraw stores crop origins from the opposite edge when an image is
	// flipped. Convert that storage convention back to the source pixels that
	// are actually visible, then include the visual mirror in the matrix.
	const visualCropX = flipX ? natural.w - crop.width - crop.x : crop.x;
	const visualCropY = flipY ? natural.h - crop.height - crop.y : crop.y;
	const scaleX = el.width / crop.width;
	const scaleY = el.height / crop.height;
	return {
		a: flipX ? -scaleX : scaleX,
		b: 0,
		c: 0,
		d: flipY ? -scaleY : scaleY,
		e: flipX ? el.width + visualCropX * scaleX : -visualCropX * scaleX,
		f: flipY ? el.height + visualCropY * scaleY : -visualCropY * scaleY,
	};
}

/**
 * Restores the coordinate relationship for a materialized viewport crop.
 *
 * A viewport crop starts as a generated PNG whose local coordinate system is
 * the bounding box of `state.polygon`. Excalidraw can subsequently native-crop,
 * flip, resize, and rotate that PNG. Its native crop is expressed in PNG pixels,
 * whereas the saved polygon/source transform is expressed in the original local
 * units. Compose the two here before applying another viewport crop.
 */
function viewportCropToCurrentLocal(
	el: ImageSceneElement,
	state: ViewportCropState,
	generatedNatural: { w: number; h: number },
): AffineTransform | null {
	const outputBounds = polygonBounds(state.polygon);
	if (!outputBounds || outputBounds.width <= 0 || outputBounds.height <= 0) return null;
	const localToGeneratedPixels: AffineTransform = {
		a: generatedNatural.w / outputBounds.width,
		b: 0,
		c: 0,
		d: generatedNatural.h / outputBounds.height,
		e: -outputBounds.x * generatedNatural.w / outputBounds.width,
		f: -outputBounds.y * generatedNatural.h / outputBounds.height,
	};
	return multiplyAffine(filePixelsToCurrentLocal(el, generatedNatural), localToGeneratedPixels);
}

function localPolygonForSceneRect(el: ImageSceneElement, rect: SceneRect): CropPoint[] | null {
	const inverse = invertAffine(elementLocalToScene(el));
	return inverse ? sceneRectPolygon(rect).map((p) => applyAffine(inverse, p)) : null;
}

interface ViewportCropPlan {
	element: ImageSceneElement;
	fileId: string;
	fileDataURL: string;
	fileData: ArrayBuffer;
	fileWidth: number;
	fileHeight: number;
	generatedPath: string;
	previousGeneratedPath?: string;
}

async function planViewportCrop(
	app: App,
	leaf: WorkspaceLeaf | null,
	el: ImageSceneElement,
	rect: SceneRect,
	sourceNatural: { w: number; h: number },
	generatedNatural: { w: number; h: number },
	files: Record<string, { dataURL?: string } | undefined>,
	sourceIsDarkThemed: boolean,
): Promise<ViewportCropPlan | null> {
	const existing = getViewportCropState(el);
	const sourceFileId = existing?.sourceFileId ?? el.fileId;
	if (!sourceFileId) return null;
	const sourceDataURL = getSourceDataURL(leaf, files, sourceFileId, sourceIsDarkThemed);
	if (!sourceDataURL) return null;
	const viewportToCurrent = existing
		? viewportCropToCurrentLocal(el, existing, generatedNatural)
		: null;
	if (existing && !viewportToCurrent) return null;
	const currentPolygon = (existing
		? existing.polygon.map((point) => applyAffine(viewportToCurrent!, point))
		: [
		{ x: 0, y: 0 },
		{ x: el.width, y: 0 },
		{ x: el.width, y: el.height },
		{ x: 0, y: el.height },
	]);
	const localRect = localPolygonForSceneRect(el, rect);
	if (!localRect) return null;
	// A crop rectangle that contains the entire current visible polygon is a
	// genuine no-op. Do not regenerate the SVG or tighten its bounds: doing so
	// changes the element's collision box and can introduce another transform
	// round-trip even though the user did not remove any pixels.
	if (currentPolygon.every((point) => pointInsideConvexPolygon(point, localRect))) return null;
	const localPolygon = intersectConvexPolygons(currentPolygon, localRect);
	if (localPolygon.length < 3) return null;
	const toScene = elementLocalToScene(el);
	const scenePolygon = localPolygon.map((p) => applyAffine(toScene, p));
	const bounds = polygonBounds(scenePolygon);
	if (!bounds || bounds.width < MIN_CROP_SCENE || bounds.height < MIN_CROP_SCENE) return null;
	const sceneToOutput: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: -bounds.x, f: -bounds.y };
	const nextPolygon = scenePolygon.map((p) => applyAffine(sceneToOutput, p));
	const currentSourceToLocal = existing
		? multiplyAffine(viewportToCurrent!, existing.sourceToLocal)
		: filePixelsToCurrentLocal(el, sourceNatural);
	const sourceToOutput = multiplyAffine(sceneToOutput, multiplyAffine(toScene, currentSourceToLocal));
	const baseCrop = existing?.baseCrop ?? el.crop ?? null;
	const sourcePath = existing?.sourcePath ?? getSourcePath(leaf, sourceFileId);
	const generatedPath = nextViewportPath(app, leaf, el.id, sourcePath);
	const state: ViewportCropState = {
		version: 1,
		sourceFileId,
		sourcePath,
		sourceNaturalWidth: existing?.sourceNaturalWidth ?? sourceNatural.w,
		sourceNaturalHeight: existing?.sourceNaturalHeight ?? sourceNatural.h,
		baseCrop,
		sourceToLocal: sourceToOutput,
		polygon: nextPolygon,
		generatedPath,
	};
	const png = await renderViewportPng(
		sourceDataURL,
		existing?.sourceNaturalWidth ?? sourceNatural.w,
		existing?.sourceNaturalHeight ?? sourceNatural.h,
		bounds.width,
		bounds.height,
		nextPolygon,
		sourceToOutput,
		sourceIsDarkThemed,
	);
	const fileId = nextViewportFileId();
	return {
		fileId,
		fileDataURL: png.dataURL,
		fileData: png.data,
		fileWidth: png.width,
		fileHeight: png.height,
		generatedPath,
		previousGeneratedPath: existing?.generatedPath,
		 element: {
			...el,
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			angle: 0,
			crop: null,
			fileId,
			// The source transform above already includes the original image's
			// flip. The generated PNG itself is in normal canvas orientation.
			scale: [1, 1],
			customData: { ...(el.customData ?? {}), [VIEWPORT_CROP_KEY]: state },
		},
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
 * Returns null when the rect misses the current visible region, or when the
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

/**
 * Mirrors image elements around their own centers. `ids` captures the selection
 * at gesture start so a pointer-up cannot accidentally affect a new selection.
 */
export function flipImageElements(leaf: WorkspaceLeaf | null, axis: ImageFlipAxis, ids?: readonly string[]): boolean {
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

	const idSet = ids ? new Set(ids) : null;
	let flipped = false;
	const nextElements = all.map((raw) => {
		if (!isImageElement(raw) || !(idSet ? idSet.has(raw.id) : selectedIds[raw.id])) return raw;
		flipped = true;
		const [scaleX = 1, scaleY = 1] = raw.scale ?? [1, 1];
		return {
			...raw,
			scale: axis === "horizontal" ? [-scaleX, scaleY] : [scaleX, -scaleY],
			version: (raw.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});
	if (!flipped) return false;

	try {
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
		return true;
	} catch {
		return false;
	}
}

/** Returns selected or all images that currently have the custom crop layer. */
export function getViewportCropImageIds(leaf: WorkspaceLeaf | null, selectedOnly: boolean): string[] {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return [];
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		return api
			.getSceneElements()
			.filter((el): el is ImageSceneElement => isImageElement(el) && (!selectedOnly || selected[el.id]) && !!getViewportCropState(el))
			.map((el) => el.id);
	} catch {
		return [];
	}
}

/**
 * Returns selected or all images carrying a *native* Excalidraw crop that this
 * plugin can restore in place — the targets for Alt+double-click.
 *
 * Deliberately narrower than "has a crop". Images with the custom viewport-crop
 * layer are excluded: plain double-click already owns those, and uncropImages
 * would take its viewport branch and peel off the custom layer instead of the
 * native crop, which is not what Alt+double-click promises. Rotated images are
 * excluded for the same reason uncropImages skips them — the axis-aligned
 * restore math does not hold once the element is turned, so those are left to
 * fall through to Excalidraw's own double-click crop editor.
 */
export function getNativeCropImageIds(leaf: WorkspaceLeaf | null, selectedOnly: boolean): string[] {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements) return [];
	try {
		const selected = api.getAppState().selectedElementIds ?? {};
		return api
			.getSceneElements()
			.filter(
				(el): el is ImageSceneElement =>
					isImageElement(el) &&
					(!selectedOnly || !!selected[el.id]) &&
					!!el.crop &&
					!getViewportCropState(el) &&
					!(el.angle && Math.abs(el.angle) > 1e-6),
			)
			.map((el) => el.id);
	} catch {
		return [];
	}
}

/** Outcome of a crop request, for debugging and caller feedback. */
export interface CropResult {
	cropped: string[];
	/** Ids skipped: missed by the rect, degenerate, or size-unknown. */
	skipped: string[];
}

/**
 * The reusable crop primitive: crop every target image so its visible region is
 * the part of it inside `rect` (scene coords). Targets `ids` when given, else the
 * current image selection. Upright and flipped images use Excalidraw's native
 * crop; rotated images use one composed polygon-clipped PNG image saved in the
 * vault. Writes all changes as one undoable step. Async because
 * uncropped images must decode to learn their true natural size (cropped images
 * already carry it in `crop.naturalWidth/Height`).
 */
export async function cropImagesToSceneRect(
	app: App,
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
	const sourceIsDarkThemed = win.document.body.classList.contains("theme-dark");
	const naturalSizeOf = makeNaturalSizeResolver(win, files);

	// Resolve each target's natural size (cropped: free; uncropped: decode), then plan.
	const plans = new Map<string, { x: number; y: number; width: number; height: number; angle?: number; crop: ImageCrop | null; fileId?: string; customData?: Record<string, unknown> }>();
	const generatedFiles: Array<{ id: string; sourceFileId: string; dataURL: string; mimeType: string; created: number; data: ArrayBuffer; path: string; width: number; height: number }> = [];
	let filesForScene: Record<string, { dataURL?: string } | undefined> | undefined;
	const generatedFilesToDelete: GeneratedViewportFileRef[] = [];
	const initialElements = new Map(targets.map((el) => [el.id, {
		version: el.version,
		versionNonce: el.versionNonce,
		fileId: el.fileId,
		customData: el.customData?.[VIEWPORT_CROP_KEY],
	}]));
	const sceneIsUnchanged = () => {
		try {
			const current = new Map(api.getSceneElements?.().map((el) => [el.id, el]));
			return targets.every((target) => {
				const before = initialElements.get(target.id);
				const now = current.get(target.id) as ImageSceneElement | undefined;
				return !!before && !!now && before.version === now.version && before.versionNonce === now.versionNonce && before.fileId === now.fileId && before.customData === now.customData?.[VIEWPORT_CROP_KEY];
			});
		} catch {
			return false;
		}
	};
	await Promise.all(
		targets.map(async (el) => {
			const viewport = getViewportCropState(el);
			// `sourceNatural` is the original image retained by a viewport crop;
			// `elementNatural` is the PNG currently attached to the element. They
			// diverge once a custom crop has been materialized, and the latter is
			// required to compose any native Excalidraw crop made in between two
			// custom crops.
			const elementNatural = el.crop
				? { w: el.crop.naturalWidth, h: el.crop.naturalHeight }
				: el.fileId
					? await naturalSizeOf(el.fileId)
					: null;
			if (!elementNatural) {
				result.skipped.push(el.id);
				return;
			}
			const sourceNatural = viewport
				? { w: viewport.sourceNaturalWidth, h: viewport.sourceNaturalHeight }
				: elementNatural;
			const viewportPlan = (el.angle && Math.abs(el.angle) > 1e-6) || getViewportCropState(el)
				? await planViewportCrop(app, leaf, el, rect, sourceNatural, elementNatural, files, sourceIsDarkThemed)
				: null;
			if (viewportPlan) {
				plans.set(el.id, {
					x: viewportPlan.element.x,
					y: viewportPlan.element.y,
					width: viewportPlan.element.width,
					height: viewportPlan.element.height,
					angle: 0,
					crop: null,
					fileId: viewportPlan.fileId,
					customData: viewportPlan.element.customData,
				});
				 generatedFiles.push({
					id: viewportPlan.fileId,
					sourceFileId: getViewportCropState(viewportPlan.element)?.sourceFileId ?? el.fileId ?? "",
					dataURL: viewportPlan.fileDataURL,
					mimeType: "image/png",
					created: Date.now(),
					data: viewportPlan.fileData,
					path: viewportPlan.generatedPath,
					width: viewportPlan.fileWidth,
					height: viewportPlan.fileHeight,
				});
				if (viewportPlan.previousGeneratedPath) {
					if (getViewportCropState(el)?.sourceFileId && el.fileId) {
						generatedFilesToDelete.push({ fileId: el.fileId, path: viewportPlan.previousGeneratedPath });
					}
				}
				return;
			}
			const plan = planImageCrop(el, rect, elementNatural);
			if (!plan) {
				result.skipped.push(el.id);
				return;
			}
			plans.set(el.id, plan);
		}),
	);
	if (plans.size === 0) return result;
	// Rendering and vault writes are asynchronous. If undo/redo or another edit
	// changed a target while that work was in flight, never write the stale crop
	// back over the restored scene.
	if (!sceneIsUnchanged()) return result;
	if (generatedFiles.length) {
		try {
			if (typeof api.addFiles !== "function") return { cropped: [], skipped: targets.map((t) => t.id) };
			for (const generated of generatedFiles) {
				await app.vault.createBinary(generated.path, generated.data);
				if (!generated.sourceFileId || !registerViewportFile(
					leaf,
					generated.sourceFileId,
					generated.id,
					generated.path,
					generated.dataURL,
					{ width: generated.width, height: generated.height },
				)) {
					throw new Error("Unable to register generated viewport crop with Excalidraw");
				}
			}
			const binaryFiles = generatedFiles.map(({ id, dataURL, mimeType, created }) => ({ id, dataURL, mimeType, created }));
			// addFiles is the only API that inserts new IDs into Excalidraw core and
			// primes its immediate render cache. updateScene({ files }) alone only
			// preserves binaries core already knows about.
			api.addFiles(binaryFiles);
			// Then submit the element swap atomically with the complete file map so
			// Obsidian's background persistence never observes an element whose
			// referenced binary is absent.
			filesForScene = { ...(api.getFiles?.() ?? {}) };
			for (const file of binaryFiles) {
				filesForScene[file.id] = file as { dataURL?: string };
			}
		} catch {
			for (const generated of generatedFiles) {
				const created = app.vault.getAbstractFileByPath(generated.path);
				if (created) void app.vault.delete(created);
			}
			return { cropped: [], skipped: targets.map((t) => t.id) };
		}
	}
	if (!sceneIsUnchanged()) {
		for (const generated of generatedFiles) {
			const created = app.vault.getAbstractFileByPath(generated.path);
			if (created) void app.vault.delete(created);
		}
		return { cropped: [], skipped: targets.map((t) => t.id) };
	}

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
			...(plan.angle !== undefined ? { angle: plan.angle } : {}),
			crop: plan.crop,
			...(plan.fileId ? { fileId: plan.fileId } : {}),
			...(plan.customData ? { customData: plan.customData } : {}),
			version: (el.version ?? 1) + 1,
			versionNonce: randomVersionNonce(),
			updated: Date.now(),
		};
	});

	try {
		view.updateScene({
			elements: nextElements,
			...(filesForScene ? { files: filesForScene } : {}),
			captureUpdate: "IMMEDIATELY",
			commitToHistory: true,
		});
	} catch {
		for (const generated of generatedFiles) {
			const created = app.vault.getAbstractFileByPath(generated.path);
			if (created) void app.vault.delete(created);
		}
		return { cropped: [], skipped: targets.map((t) => t.id) };
	}
	await deleteDetachedViewportFiles(app, leaf, generatedFilesToDelete);
	return result;
}

/**
 * Clears the `crop` on target images, restoring each to its full original at the
 * right on-canvas position/size — the inverse of cropImagesToSceneRect and the
 * programmatic equivalent of Excalidraw's double-click uncrop. For custom
 * viewport-cropped images this removes only the custom layer and restores the
 * underlying native-cropped image; ordinary images are restored as before.
 * Synchronous: natural size comes from the existing crop, so nothing is decoded.
 */
export async function uncropImages(app: App, leaf: WorkspaceLeaf | null, ids?: readonly string[]): Promise<string[]> {
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
	const generatedFilesToDelete: GeneratedViewportFileRef[] = [];
	const nextElements = all.map((raw) => {
		if (!isImageElement(raw)) return raw;
		const el = raw;
		const target = idSet ? idSet.has(el.id) : !!selectedIds[el.id];
		const viewport = getViewportCropState(el);
		if (target && viewport) {
			if (viewport.generatedPath && el.fileId) {
				generatedFilesToDelete.push({ fileId: el.fileId, path: viewport.generatedPath });
			}
			const crop = viewport.baseCrop;
			const nw = viewport.sourceNaturalWidth;
			const nh = viewport.sourceNaturalHeight;
			const sourceCrop = crop ?? { x: 0, y: 0, width: nw, height: nh };
			// The generated viewport PNG may itself have been natively cropped before
			// this double-click. Fold that generated-PNG crop back into the original
			// source transform, otherwise the restored element is offset by the crop
			// origin (and becomes increasingly wrong after repeated operations).
			const generatedNatural = el.crop
				? { w: el.crop.naturalWidth, h: el.crop.naturalHeight }
				: (() => {
					const bounds = polygonBounds(viewport.polygon);
					return bounds ? { w: bounds.width, h: bounds.height } : null;
				})();
			if (!generatedNatural) return raw;
			const viewportToCurrent = viewportCropToCurrentLocal(el, viewport, generatedNatural);
			if (!viewportToCurrent) return raw;
			const sourceToScene = multiplyAffine(
				elementLocalToScene(el),
				multiplyAffine(viewportToCurrent, viewport.sourceToLocal),
			);
			const p0 = applyAffine(sourceToScene, { x: sourceCrop.x, y: sourceCrop.y });
			const p1 = applyAffine(sourceToScene, { x: sourceCrop.x + sourceCrop.width, y: sourceCrop.y });
			const p2 = applyAffine(sourceToScene, { x: sourceCrop.x, y: sourceCrop.y + sourceCrop.height });
			const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
			const height = Math.hypot(p2.x - p0.x, p2.y - p0.y);
			if (width <= 0 || height <= 0) return raw;
			const orientation = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
			const center = {
				x: (p0.x + p1.x + p2.x + (p1.x + p2.x - p0.x)) / 4,
				y: (p0.y + p1.y + p2.y + (p1.y + p2.y - p0.y)) / 4,
			};
			const customData = { ...(el.customData ?? {}) };
			delete customData[VIEWPORT_CROP_KEY];
			uncropped.push(el.id);
			return {
				...el,
				fileId: viewport.sourceFileId,
				x: center.x - width / 2,
				y: center.y - height / 2,
				width,
				height,
				angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
				crop: crop ?? null,
				// The affine transform above contains any original or subsequently
				// applied mirror. Encode its handedness exactly once in the restored
				// element; retaining the generated PNG's scale would mirror it twice.
				scale: [1, orientation < 0 ? -1 : 1],
				customData: Object.keys(customData).length ? customData : undefined,
				version: (el.version ?? 1) + 1,
				versionNonce: randomVersionNonce(),
				updated: Date.now(),
			};
		}
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
	await deleteDetachedViewportFiles(app, leaf, generatedFilesToDelete);
	return uncropped;
}

/**
 * PureRef-style Ctrl+Arrow gravity pack: settle the selection toward `direction`.
 * See applyPack for the no-op contract (lets Excalidraw's arrow-nudge proceed).
 */
export function packSelectedElements(leaf: WorkspaceLeaf | null, direction: PackDirection): boolean {
	return applyPack(leaf, (selected, gap) => planPack(selected, direction, gap));
}

/**
 * PureRef-style Ctrl+Shift+P "Optimal" arrange: re-lay the selection into a
 * compact, roughly-square, top-left-anchored block. See applyPack for the no-op
 * contract.
 */
export function optimalPackSelectedElements(leaf: WorkspaceLeaf | null): boolean {
	return applyPack(leaf, (selected, gap) => planOptimalPack(selected, gap));
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
