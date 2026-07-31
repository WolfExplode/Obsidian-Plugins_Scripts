import type { App, TFile, WorkspaceLeaf } from "obsidian";
import {
	isPackable,
	planPack,
	planOptimalPack,
	type PackDirection,
	type PackElement,
	type PackMove,
} from "./pack-elements";
import { planOverlapAwareZOrderMove, type ZOrderDirection } from "./zorder";
import { type ImageCrop, type SceneRect } from "./crop-geometry";

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
	return getExcalidrawFileForLeaf(app.workspace.getMostRecentLeaf());
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
export interface SceneElement extends PackElement {
	version?: number;
	opacity?: number;
	/** Nested Excalidraw group ids; the last id is the outermost group. */
	groupIds?: readonly string[];
	frameId?: string | null;
}

export interface ExcalidrawApi {
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
		gridModeEnabled?: boolean;
		gridSize?: number;
		boxSelectionMode?: "contain" | "overlap";
		selectedElementIds?: Record<string, boolean>;
		/** Non-null while Excalidraw is editing inside a group's constituents. */
		editingGroupId?: string | null;
		/**
		 * `"dark"` means Excalidraw renders the whole scene through
		 * `DARK_THEME_FILTER`, baked into the canvas pixels rather than applied as
		 * CSS -- so anything drawn alongside its canvas has to apply it too.
		 */
		theme?: string;
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

export interface ExcalidrawEmbeddedFileLike {
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

export function getExcalidrawView(leaf: WorkspaceLeaf | null): ExcalidrawViewLike | null {
	if (!isExcalidrawLeaf(leaf)) return null;
	return leaf!.view;
}

export function getExcalidrawApi(leaf: WorkspaceLeaf | null): ExcalidrawApi | null {
	const view = getExcalidrawView(leaf);
	return view?.excalidrawAPI ?? null;
}

export function getExcalidrawData(leaf: WorkspaceLeaf | null): ExcalidrawDataLike | null {
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
 * Excalidraw's own "Loading scene…" overlay (rendered as a `.LoadingMessage`
 * element while it decodes embedded files) is still up. The API can be live
 * and reporting a measured container well before this clears on a heavy Board
 * — poking updateScene/resize while it's still visible has been observed to
 * orphan Excalidraw's own file-load promise chain and leave the overlay
 * stuck forever, even though the elements themselves loaded fine. Callers
 * must wait for this to go false, not just for isCanvasReady().
 */
export function hasLoadingOverlay(leaf: WorkspaceLeaf | null): boolean {
	const view = getExcalidrawView(leaf);
	return !!view?.containerEl?.querySelector(".LoadingMessage");
}

/**
 * True while any non-deleted element that references a binary file (images;
 * embeddables carry their own iframe content and don't count) has no matching
 * entry in getFiles() yet. hasLoadingOverlay() alone is racy: right after
 * mount, Excalidraw hasn't decided to show the overlay yet, so a lone overlay
 * check can pass a beat before the real file-decode work — and the resulting
 * resize/updateScene call is what was observed to orphan that decode, leaving
 * the overlay stuck forever once it does appear. This checks the actual data
 * Excalidraw is waiting on instead of its transient UI state.
 */
export function hasUnloadedFiles(leaf: WorkspaceLeaf | null): boolean {
	const api = getExcalidrawApi(leaf);
	if (!api?.getSceneElements || !api?.getFiles) return false;
	try {
		const files = api.getFiles();
		return (api.getSceneElements() as readonly ImageSceneElement[]).some(
			(el) => !el.isDeleted && el.fileId && !files[el.fileId],
		);
	} catch {
		return false;
	}
}

/**
 * Hides (or reveals) a Popout's Excalidraw container while its startup camera
 * and zen mode are still being applied, so the "mounts at Excalidraw's default
 * view, then visibly snaps to the saved viewport" transition isn't visible.
 *
 * Deliberately an inline style on the container element itself, not a CSS
 * class on the window's <body> (see the identical lesson already documented
 * in chrome-hider.ts: Obsidian resets custom classes it doesn't own on a
 * popout's <body> shortly after the window opens, silently discarding
 * anything added that way). The container element itself isn't subject to
 * that reset and isn't recreated by Excalidraw's own re-renders, so a plain
 * inline style here doesn't need chrome-hider's MutationObserver reapply.
 */
// Passed as variables (not inlined) so this stays a forced inline !important
// style — see the docblock above — without reading as swappable-for-a-class.
const VEIL_IMPORTANT = "important";
const VEIL_HIDDEN = "hidden";

export function setContainerVeiled(leaf: WorkspaceLeaf | null, veiled: boolean): void {
	const container = getExcalidrawView(leaf)?.containerEl;
	if (!container) return;
	if (veiled) {
		container.style.setProperty("visibility", VEIL_HIDDEN, VEIL_IMPORTANT);
	} else {
		container.style.removeProperty("visibility");
	}
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

/** The same ten-percent increment used by Excalidraw's opacity control. */
const ELEMENT_OPACITY_STEP = 10;

/** A pseudo-random 31-bit integer for an element's versionNonce (mirrors Excalidraw). */
export function randomVersionNonce(): number {
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
 * Turns the selected reference elements into packing units. An outer Excalidraw
 * group is one unit whose box contains every live member (including labels and
 * decorative shapes), and whose resulting translation is applied to every
 * member. This prevents packing an image away from the rest of its group.
 */
function getPackUnits(
	all: readonly SceneElement[],
	selectedIds: Record<string, boolean>,
	editingGroupId: string | null | undefined,
): {
	units: PackElement[];
	memberIdsByUnit: Map<string, ReadonlySet<string>>;
} {
	const selectedPackable = all.filter((el) => selectedIds[el.id] && isPackable(el));
	// Drilling into a group is Excalidraw's explicit signal that its constituents
	// are being selected as independent elements. In that mode, do not collapse
	// them back into one packing unit merely because every member is selected.
	const selectedGroupIds = editingGroupId
		? new Set<string>()
		: new Set(selectedPackable.flatMap((el) => el.groupIds?.length ? [el.groupIds[el.groupIds.length - 1]] : []));
	const units: PackElement[] = [];
	const memberIdsByUnit = new Map<string, ReadonlySet<string>>();

	for (const groupId of selectedGroupIds) {
		const members = all.filter((el) => !el.isDeleted && el.groupIds?.[el.groupIds.length - 1] === groupId);
		if (members.length === 0) continue;
		const bounds = members.map((el) => {
			const angle = el.angle ?? 0;
			const cos = Math.abs(Math.cos(angle));
			const sin = Math.abs(Math.sin(angle));
			const halfWidth = (cos * el.width + sin * el.height) / 2;
			const halfHeight = (sin * el.width + cos * el.height) / 2;
			const centerX = el.x + el.width / 2;
			const centerY = el.y + el.height / 2;
			return { minX: centerX - halfWidth, minY: centerY - halfHeight, maxX: centerX + halfWidth, maxY: centerY + halfHeight };
		});
		const minX = Math.min(...bounds.map((box) => box.minX));
		const minY = Math.min(...bounds.map((box) => box.minY));
		const maxX = Math.max(...bounds.map((box) => box.maxX));
		const maxY = Math.max(...bounds.map((box) => box.maxY));
		const unitId = `group:${groupId}`;
		units.push({ id: unitId, type: "image", x: minX, y: minY, width: maxX - minX, height: maxY - minY });
		memberIdsByUnit.set(unitId, new Set(members.map((el) => el.id)));
	}

	for (const el of selectedPackable) {
		if (el.groupIds?.length && selectedGroupIds.has(el.groupIds[el.groupIds.length - 1])) continue;
		units.push(el);
		memberIdsByUnit.set(el.id, new Set([el.id]));
	}
	return { units, memberIdsByUnit };
}

/**
 * Shared plumbing for the PureRef arranges: read selected packable references,
 * treating Excalidraw groups as indivisible units, then write the resulting
 * translations as one undoable history entry. Returns false (a no-op) when fewer
 * than two units are selected or the plan is empty.
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
	let editingGroupId: string | null | undefined;
	try {
		all = api.getSceneElements();
		const appState = api.getAppState();
		selectedIds = appState.selectedElementIds ?? {};
		editingGroupId = appState.editingGroupId;
	} catch {
		return false;
	}

	const { units, memberIdsByUnit } = getPackUnits(all, selectedIds, editingGroupId);
	if (units.length < 2) return false;

	const moves = plan(units);
	if (moves.length === 0) return false;

	const moveById = new Map<string, PackMove>();
	for (const move of moves) {
		for (const memberId of memberIdsByUnit.get(move.id) ?? []) moveById.set(memberId, move);
	}
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

/**
 * Overlap-aware Bring Forward / Send Backward for the current selection (see
 * docs/behavior/overlap-aware-zorder.md and zorder.ts). Writes the reordered
 * scene as one undoable history entry, mirroring applyPack's updateScene call.
 *
 * Returns false -- a deliberate no-op -- when there's no selection, nothing
 * actually moves, or the selection touches a group/frame (editingGroupId, or
 * any selected element with groupIds/frameId). Group/frame z-order has real
 * dedicated semantics in Excalidraw's own zindex.ts that aren't reimplemented
 * here; callers should let the native Ctrl+]/Ctrl+[ handler run instead.
 */
export function bringSelectionPastOverlap(leaf: WorkspaceLeaf | null, direction: ZOrderDirection): boolean {
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	let selectedIds: Record<string, boolean>;
	let editingGroupId: string | null | undefined;
	try {
		all = api.getSceneElements();
		const appState = api.getAppState();
		selectedIds = appState.selectedElementIds ?? {};
		editingGroupId = appState.editingGroupId;
	} catch {
		return false;
	}
	if (editingGroupId) return false;

	const ids = new Set(Object.keys(selectedIds).filter((id) => selectedIds[id]));
	if (ids.size === 0) return false;

	const next = planOverlapAwareZOrderMove(all, ids, direction);
	if (!next) return false;

	try {
		view.updateScene({ elements: next, captureUpdate: "IMMEDIATELY", commitToHistory: true });
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
	captureUpdate: "NEVER" | "EVENTUALLY" | "IMMEDIATELY",
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
 * Marks specific scene elements deleted in one undoable step, leaving every
 * other element untouched. Used to remove the placeholder `image` element the
 * animated-image-to-embeddable converter replaces with an `embeddable`.
 */
export function deleteSceneElements(leaf: WorkspaceLeaf | null, ids: readonly string[]): boolean {
	if (ids.length === 0) return false;
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	try {
		all = api.getSceneElements();
	} catch {
		return false;
	}

	const idSet = new Set(ids);
	let changed = false;
	const nextElements = all.map((el) => {
		if (!idSet.has(el.id) || el.isDeleted) return el;
		changed = true;
		return {
			...el,
			isDeleted: true,
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

// The crop coordinate math lives in crop-geometry.ts (pure, no Obsidian or
// Excalidraw dependency). ImageCrop and SceneRect are re-exported so existing
// callers -- crop-drag.ts, media-export.ts -- keep importing them from here.
export type { ImageCrop, SceneRect } from "./crop-geometry";

export type ImageFlipAxis = "horizontal" | "vertical";

/** The image-element fields the crop primitive reads. */
export interface ImageSceneElement extends SceneElement {
	versionNonce?: number;
	angle?: number;
	scale?: readonly [number, number];
	crop?: ImageCrop | null;
	fileId?: string;
	customData?: Record<string, unknown>;
}

/** Whether an element is a live (non-deleted) Excalidraw image. */
export function isImageElement(el: SceneElement): el is ImageSceneElement {
	return el.type === "image" && !el.isDeleted;
}

/**
 * Decodes an image's natural pixel size from its dataURL, memoized per fileId so
 * a multi-image crop decodes each source at most once. Resolves null on failure.
 */
export function makeNaturalSizeResolver(win: Window, files: Record<string, { dataURL?: string } | undefined>) {
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
 * Alt+S).
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

/**
 * The vault file a scene `image` element's `fileId` resolves to, straight from
 * the Excalidraw plugin's own file registry (`excalidrawData.getFile`). Used
 * by the animated-image-to-embeddable converter to identify a freshly-inserted
 * gif/webp/apng without needing its own bookkeeping of vault paths.
 */
export function getSceneElementFile(leaf: WorkspaceLeaf | null, fileId: string): TFile | null {
	try {
		return getExcalidrawData(leaf)?.getFile?.(fileId)?.file ?? null;
	} catch {
		return null;
	}
}

/**
 * The active Excalidraw leaf: the focused leaf when it's an Excalidraw view, else
 * the first Excalidraw view anywhere (main window or a popout). Convenience for
 * command/debug entry points that don't have an event target to locate from.
 */
export function getActiveExcalidrawLeaf(app: App): WorkspaceLeaf | null {
	const recent = app.workspace.getMostRecentLeaf();
	if (isExcalidrawLeaf(recent)) return recent;
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

/**
 * Returns the active grid spacing, or null when grid snapping is disabled.
 * This mirrors Excalidraw's `getEffectiveGridSize()`: a configured grid only
 * affects element movement while grid mode itself is enabled.
 */
export function getEffectiveGridSize(leaf: WorkspaceLeaf | null): number | null {
	const api = getExcalidrawApi(leaf);
	if (!api) return null;
	try {
		const state = api.getAppState();
		return state.gridModeEnabled && typeof state.gridSize === "number" && state.gridSize > 0
			? state.gridSize
			: null;
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
 * Lays out a specific group of newly-created reference elements as one compact,
 * PureRef-style block. Unlike the keyboard command this deliberately does not
 * depend on Excalidraw's selection state: an importer is free to clear or alter
 * selection while it is adding files. Existing board elements are left exactly
 * where they are.
 */
export function optimalPackElementsById(leaf: WorkspaceLeaf | null, ids: ReadonlySet<string>): boolean {
	if (ids.size < 2) return false;
	const api = getExcalidrawApi(leaf);
	const view = getExcalidrawView(leaf);
	if (!api?.getSceneElements || !view?.updateScene) return false;

	let all: readonly SceneElement[];
	try {
		all = api.getSceneElements();
	} catch {
		return false;
	}

	const imported = all.filter((el) => ids.has(el.id) && isPackable(el));
	if (imported.length < 2) return false;
	const moves = planOptimalPack(imported, PACK_GAP);
	if (moves.length === 0) return false;

	const moveById = new Map(moves.map((move) => [move.id, move]));
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
		view.updateScene({ elements: nextElements, captureUpdate: "IMMEDIATELY", commitToHistory: true });
		return true;
	} catch {
		return false;
	}
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
