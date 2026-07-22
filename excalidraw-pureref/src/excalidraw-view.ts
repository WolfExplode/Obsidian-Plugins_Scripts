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
		zenModeEnabled?: boolean;
		boxSelectionMode?: "contain" | "overlap";
		selectedElementIds?: Record<string, boolean>;
	};
	getSceneElements?(): readonly SceneElement[];
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
