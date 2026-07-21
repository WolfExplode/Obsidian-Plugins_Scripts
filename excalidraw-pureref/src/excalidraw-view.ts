import type { App, TFile, WorkspaceLeaf } from "obsidian";

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
interface ExcalidrawApi {
	getAppState(): {
		scrollX: number;
		scrollY: number;
		zoom: { value: number };
		width: number;
		height: number;
		zenModeEnabled?: boolean;
		viewBackgroundColor?: string;
		gridModeEnabled?: boolean;
		gridSize?: number;
	};
}

interface ExcalidrawViewLike {
	containerEl?: HTMLElement;
	excalidrawAPI?: ExcalidrawApi;
	updateScene?(scene: { appState: Record<string, unknown> }): void;
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

export interface ExcalidrawPresentationState {
	viewBackgroundColor: string | null;
	gridModeEnabled: boolean;
	gridSize: number;
}

export function readPresentationState(leaf: WorkspaceLeaf | null): ExcalidrawPresentationState | null {
	const api = getExcalidrawApi(leaf);
	if (!api) return null;
	try {
		const state = api.getAppState();
		return {
			viewBackgroundColor: state.viewBackgroundColor ?? null,
			gridModeEnabled: state.gridModeEnabled ?? false,
			gridSize: state.gridSize ?? 0,
		};
	} catch {
		return null;
	}
}

export function applyPresentationState(
	leaf: WorkspaceLeaf | null,
	state: Partial<ExcalidrawPresentationState>,
): boolean {
	return updateExcalidrawScene(leaf, state as Record<string, unknown>);
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
