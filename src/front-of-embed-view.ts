import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { planFrontOfEmbedOverlaps, type FrontOfEmbedElement } from "./front-of-embed";
import { elementAABB } from "./pack-elements";
import { getExcalidrawApi, readSceneElements } from "./excalidraw-view";
import { attachPerLeafScanner, leafDocument, type LeafScannerApi, type LeafScannerHandle } from "./leaf-scanner";

/**
 * DOM/API glue for Front-of-embed rendering -- see
 * docs/behavior/front-of-embed-rendering.md and
 * docs/adr/0010-front-of-embed-rendering.md for the mechanism this
 * implements. front-of-embed.ts (pure, dependency-free) decides WHICH
 * elements need the treatment; this file decides HOW: mounting a DOM overlay
 * canvas above every embeddable, rasterizing at-rest candidates onto it, and
 * dimming embeddable DOM nodes for live feedback while a gesture is in
 * progress.
 *
 * Rides the same attach/prune/reconcile lifecycle as video-aspect.ts,
 * animated-image-drop.ts, and media-auto-pack.ts (attachPerLeafScanner in
 * leaf-scanner.ts) -- one registration covers the main window and every
 * Popout, attaching to views as they mount and detaching as they close.
 */

/** Fixed dim level for an embeddable while a live gesture over it is in progress. Not a setting in v1. */
const GESTURE_DIM_OPACITY = "0.4";
/** Above .excalidraw__canvas (z-index 1) and .interactive (2); below Excalidraw's own UI chrome (--zIndex-layerUI: 4+). */
const OVERLAY_Z_INDEX = "3";

interface SceneBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * scrollX/scrollY/zoom only -- deliberately NOT offsetLeft/offsetTop.
 * Excalidraw's appState offsetLeft/offsetTop are the `.excalidraw` root's own
 * position on the page (verified live: equal to the root's
 * getBoundingClientRect(), to the pixel), used for page-relative pointer math.
 * The overlay canvas is a CSS-positioned child of that same root (`inset: 0`),
 * so its own drawing surface is already root-local -- adding offsetLeft/Top
 * again double-counts the root's page position. Confirmed live: an element
 * placed to overlap an embeddable rasterized ~(offsetLeft, offsetTop) px away
 * from where it should have appeared until this was removed.
 */
interface ViewportSnapshot {
	scrollX: number;
	scrollY: number;
	zoom: number;
}

interface RasterState {
	/**
	 * Identifies which candidate elements (and versions) produced `bitmap` --
	 * i.e. what's actually currently displayed. `bitmap`, `bounds`, and `ids`
	 * always describe this same set; they're only ever replaced together, in
	 * one assignment, once a matching export resolves. Never updated eagerly.
	 */
	key: string | null;
	/**
	 * Key of the most recently *requested* export, which may still be
	 * in-flight -- separate from `key` so rasterize() can dedupe repeated
	 * requests for the same candidate set without touching what's displayed
	 * while the request is pending. Read repaint()'s comment before changing
	 * this: pairing `bounds` with a not-yet-arrived `bitmap` was the exact bug
	 * (verified live, 2026-07-29) behind an overlaid element visibly warping
	 * while being dragged across an embeddable -- each re-scan updated bounds
	 * to the new position/size immediately, but drawImage kept stretching the
	 * still-old bitmap into that new rectangle until the fresh export landed.
	 */
	pendingKey: string | null;
	/** Guards against an in-flight exportToBlob resolving after a newer request superseded it, or after teardown. */
	token: number;
	bitmap: ImageBitmap | null;
	bounds: SceneBounds | null;
	/** Ids of the elements baked into `bitmap`, so a live gesture can tell whether it's dragging one of them (see `overlaySuppressed`). */
	ids: readonly string[];
}

interface FrontOfEmbedState {
	root: HTMLElement;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	resizeObserver: ResizeObserver;
	/** Embeddable ids currently dimmed for live-gesture feedback. */
	dimmed: Set<string>;
	pointerDown: boolean;
	/** Set by scan() while a gesture is live: true when the overlay's frozen bitmap would show a stale copy of whatever's currently selected/moving, so repaint() should blank it instead. */
	overlaySuppressed: boolean;
	raster: RasterState;
	lastViewport: ViewportSnapshot | null;
	rafHandle: number;
	detachPointer: () => void;
}

/** Minimal shape of the `window.ExcalidrawLib` global the Excalidraw plugin injects per-window (PackageManager.ts). */
interface ExcalidrawLibGlobal {
	exportToBlob?(opts: {
		elements: readonly unknown[];
		appState?: Record<string, unknown>;
		files: unknown;
		mimeType?: string;
		exportPadding?: number;
	}): Promise<Blob>;
	getCommonBoundingBox?(elements: readonly unknown[]): SceneBounds;
}

function windowOf(leaf: WorkspaceLeaf): (Window & { ExcalidrawLib?: ExcalidrawLibGlobal }) | null {
	return (leafDocument(leaf)?.defaultView as (Window & { ExcalidrawLib?: ExcalidrawLibGlobal }) | null) ?? null;
}

function findExcalidrawRoot(leaf: WorkspaceLeaf): HTMLElement | null {
	const containerEl = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
	return containerEl?.querySelector<HTMLElement>(".excalidraw") ?? null;
}

/** Same rotation-aware AABB union other Board features (pack-elements.ts, zorder.ts) already use, as a fallback if ExcalidrawLib's own bounding-box helper is unavailable. */
function unionBounds(elements: readonly FrontOfEmbedElement[]): SceneBounds | null {
	if (elements.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const element of elements) {
		const rect = elementAABB(element);
		minX = Math.min(minX, rect.minX);
		minY = Math.min(minY, rect.minY);
		maxX = Math.max(maxX, rect.maxX);
		maxY = Math.max(maxY, rect.maxY);
	}
	return { minX, minY, maxX, maxY };
}

function raterKey(elements: readonly FrontOfEmbedElement[]): string {
	return elements
		.map((element) => `${element.id}:${element.version ?? 0}`)
		.sort()
		.join("|");
}

/**
 * Maps each non-deleted embeddable element to its `.excalidraw__embeddable-container`
 * DOM node, by position rather than id.
 *
 * Verified live (2026-07-29, MCP-attached against a running board): the
 * bundled Excalidraw fork's embeddable container carries no id or data
 * attribute identifying which scene element it renders -- only
 * `CustomEmbeddable.tsx`'s `#embed-${element.id}` markup (used for local
 * Obsidian-rendered embeds) has one, and this board's web/YouTube embeddables
 * render through a plain `<webview>` with no such wrapper at all. Positional
 * correlation is used instead: the root-cause doc for
 * excalidraw-embeddable-z-order-limitation.md already established that
 * `renderEmbeddables()` maps embeddables in scene order, and a live check
 * (comparing two embeddables' screen transforms against their scene y
 * values) confirmed DOM order matches scene array order. If the counts don't
 * match -- e.g. mid-render, or a container type this plugin hasn't accounted
 * for -- this returns an empty map and dimming is skipped for that tick
 * rather than guessing.
 */
function mapEmbeddableContainers(root: HTMLElement, elements: readonly FrontOfEmbedElement[]): ReadonlyMap<string, HTMLElement> {
	const embeddableElements = elements.filter((element) => element.type === "embeddable" && !element.isDeleted);
	const containers = Array.from(root.querySelectorAll<HTMLElement>(".excalidraw__embeddable-container"));
	if (containers.length !== embeddableElements.length) return new Map();
	const map = new Map<string, HTMLElement>();
	embeddableElements.forEach((element, index) => map.set(element.id, containers[index]));
	return map;
}

/**
 * Sets or restores an embeddable container's opacity. Verified live: writing
 * `style.opacity` directly on `.excalidraw__embeddable-container` survives
 * both an unrelated scene mutation and a mutation of the embeddable's own
 * position (two separate `updateScene` calls, checked after each) without
 * Excalidraw's own re-render stomping it back -- so this only needs to run on
 * the dimmed/restored transition, not every scan tick. Not confirmed against
 * a live pointer-driven drag specifically (only programmatic `updateScene`),
 * so if a real drag is ever observed reverting this, re-apply on every tick
 * instead of only on transition.
 */
function setEmbeddableDimmed(node: HTMLElement, dimmed: boolean): void {
	node.style.opacity = dimmed ? GESTURE_DIM_OPACITY : "1";
}

function mountOverlay(leaf: WorkspaceLeaf, root: HTMLElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; resizeObserver: ResizeObserver } {
	const win = windowOf(leaf) ?? window;
	const canvas = win.document.createElement("canvas");
	canvas.className = "epr-front-of-embed-overlay";
	canvas.style.position = "absolute";
	canvas.style.inset = "0";
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvas.style.pointerEvents = "none";
	canvas.style.zIndex = OVERLAY_Z_INDEX;
	root.appendChild(canvas);

	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Unable to create 2d context for front-of-embed overlay canvas");

	const resize = () => {
		const dpr = win.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(root.clientWidth * dpr));
		const height = Math.max(1, Math.round(root.clientHeight * dpr));
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	};
	resize();
	// Not window-scoped: ResizeObserver's constructor isn't declared on the
	// Window interface in this project's pinned TypeScript/lib version, and
	// observing a Popout's DOM node works fine via the global constructor.
	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(root);

	return { canvas, ctx, resizeObserver };
}

function currentViewport(leaf: WorkspaceLeaf): ViewportSnapshot | null {
	const api = getExcalidrawApi(leaf);
	if (!api?.getAppState) return null;
	try {
		const state = api.getAppState();
		return {
			scrollX: state.scrollX,
			scrollY: state.scrollY,
			zoom: state.zoom.value,
		};
	} catch {
		return null;
	}
}

function viewportsEqual(a: ViewportSnapshot | null, b: ViewportSnapshot | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom;
}

/** Redraws the overlay from whatever's already rasterized -- never triggers a new export. Cheap enough to call every animation frame. */
function repaint(state: FrontOfEmbedState, viewport: ViewportSnapshot): void {
	const { ctx, canvas } = state;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	// While a gesture is live and scan() has determined the frozen bitmap is
	// stale for it (see overlaySuppressed's setter in scan()), the overlay
	// stays blank until the gesture ends and a fresh rasterization lands --
	// otherwise it doubles whatever's moving: Excalidraw's own canvas already
	// renders the live, moving element in real time, and drawing the old
	// snapshot on top of that (at its pre-drag position) painted a ghost copy.
	if (state.pointerDown && state.overlaySuppressed) return;
	const { bitmap, bounds } = state.raster;
	if (!bitmap || !bounds) return;
	const x = (bounds.minX + viewport.scrollX) * viewport.zoom;
	const y = (bounds.minY + viewport.scrollY) * viewport.zoom;
	const width = (bounds.maxX - bounds.minX) * viewport.zoom;
	const height = (bounds.maxY - bounds.minY) * viewport.zoom;
	ctx.drawImage(bitmap, x, y, width, height);
}

/** Kicks off (at most one in flight per state) a fresh rasterization of `candidates`, repainting once it resolves. */
function rasterize(leaf: WorkspaceLeaf, state: FrontOfEmbedState, candidates: readonly FrontOfEmbedElement[]): void {
	const key = raterKey(candidates);
	if (key === state.raster.pendingKey) return;
	const ids = candidates.map((element) => element.id);

	const lib = windowOf(leaf)?.ExcalidrawLib;
	const api = getExcalidrawApi(leaf);
	if (!lib?.exportToBlob || !api?.getFiles) {
		// Can't export at all -- clear what's displayed rather than leaving a
		// stale bitmap/bounds pair, but still track this as the pending request
		// so a scan() with the same unchanged candidates doesn't retry every tick.
		state.raster = { key: null, pendingKey: key, token: state.raster.token, bitmap: null, bounds: null, ids: [] };
		return;
	}

	const bounds = lib.getCommonBoundingBox?.(candidates) ?? unionBounds(candidates);
	const token = state.raster.token + 1;
	// Only pendingKey/token move yet -- key/bitmap/bounds/ids (what repaint()
	// actually draws) stay untouched until the matching bitmap below resolves,
	// so they're never out of sync with each other.
	state.raster = { ...state.raster, pendingKey: key, token };

	// exportToBlob renders raw element colors and ignores the live canvas's
	// dark-mode color filter unless told to reapply it -- verified live
	// (2026-07-29, MCP-attached): a #1e1e1e rectangle (Excalidraw's default
	// "black", shown near-white on screen in dark theme) exported back to
	// near-black (30,30,30) without `exportWithDarkMode`, and to the expected
	// near-white (211,211,211) with it. Without this, every default-colored
	// element flips to its light-theme color once rasterized onto the overlay.
	const isDarkMode = api.getAppState().theme === "dark";

	void lib
		.exportToBlob({
			elements: candidates,
			files: api.getFiles(),
			mimeType: "image/png",
			exportPadding: 0,
			appState: { exportBackground: false, exportWithDarkMode: isDarkMode },
		})
		.then(async (blob) => {
			if (state.raster.token !== token) return; // superseded by a newer request, or torn down
			const bitmap = await createImageBitmap(blob);
			if (state.raster.token !== token) {
				bitmap.close();
				return;
			}
			state.raster.bitmap?.close();
			state.raster = { key, pendingKey: key, token, bitmap, bounds, ids };
			const viewport = currentViewport(leaf);
			if (viewport) repaint(state, viewport);
		})
		.catch(() => {
			// Leaves the previous bitmap on screen (stale but not wrong-looking)
			// rather than blanking the overlay on a transient export failure.
		});
}

function tick(leaf: WorkspaceLeaf, state: FrontOfEmbedState, scanner: LeafScannerHandle<FrontOfEmbedState>): void {
	if (scanner.isDisposed()) return;
	if (!state.canvas.isConnected) {
		// The Excalidraw plugin can replace its `.excalidraw` root without closing
		// the leaf (e.g. a mode switch) -- reattach rather than drawing into a
		// detached node forever.
		const root = findExcalidrawRoot(leaf);
		if (root) root.appendChild(state.canvas);
	}
	const viewport = currentViewport(leaf);
	if (viewport && !viewportsEqual(viewport, state.lastViewport)) {
		state.lastViewport = viewport;
		repaint(state, viewport);
	}
	state.rafHandle = (windowOf(leaf) ?? window).requestAnimationFrame(() => tick(leaf, state, scanner));
}

function setup(leaf: WorkspaceLeaf, _api: LeafScannerApi, scanner: LeafScannerHandle<FrontOfEmbedState>): FrontOfEmbedState | null {
	const root = findExcalidrawRoot(leaf);
	if (!root) return null;
	const doc = leafDocument(leaf);
	const win = windowOf(leaf);
	if (!doc || !win) return null;

	const { canvas, ctx, resizeObserver } = mountOverlay(leaf, root);

	const state: FrontOfEmbedState = {
		root,
		canvas,
		ctx,
		resizeObserver,
		dimmed: new Set(),
		pointerDown: false,
		overlaySuppressed: false,
		raster: { key: null, pendingKey: null, token: 0, bitmap: null, bounds: null, ids: [] },
		lastViewport: null,
		rafHandle: 0,
		detachPointer: () => {},
	};

	const onPointerDown = (e: PointerEvent) => {
		// Only the primary button (left click / touch / pen) drives an actual
		// editing gesture (drag/resize/rotate/draw). Middle-mouse-drag panning
		// and right-click both fire pointerdown too; treating those as a gesture
		// start left the overlay blank (see repaint) and dimmed the embeddable
		// underneath for the duration of the pan, with nothing ever un-dimming
		// it mid-drag since no element was actually moving.
		if (e.button !== 0) return;
		state.pointerDown = true;
	};
	const onPointerUp = () => {
		if (!state.pointerDown) return;
		state.pointerDown = false;
		scanner.rescan(leaf);
	};
	doc.addEventListener("pointerdown", onPointerDown, true);
	doc.addEventListener("pointerup", onPointerUp, true);
	doc.addEventListener("pointercancel", onPointerUp, true);
	state.detachPointer = () => {
		doc.removeEventListener("pointerdown", onPointerDown, true);
		doc.removeEventListener("pointerup", onPointerUp, true);
		doc.removeEventListener("pointercancel", onPointerUp, true);
	};

	state.rafHandle = win.requestAnimationFrame(() => tick(leaf, state, scanner));
	return state;
}

function scan(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	const elements = readSceneElements(leaf) as readonly FrontOfEmbedElement[] | null;
	if (!elements) return;

	const overlaps = planFrontOfEmbedOverlaps(elements);
	const containers = mapEmbeddableContainers(state.root, elements);

	if (state.pointerDown) {
		// Live gesture: dim exactly the embeddables a currently-qualifying
		// element overlaps, so the user sees Excalidraw's own real-time
		// rendering through the translucency instead of a mirrored
		// approximation. The overlay itself stays blank meanwhile (see repaint).
		//
		// Restricted to selected elements: `overlaps` reflects every eligible
		// element's *current* geometry, including ones sitting still. Without
		// this filter, a left-click drag anywhere on the canvas (selecting/
		// moving an unrelated element, or even just a selection-box drag over
		// empty space) dimmed embeddables under completely uninvolved,
		// stationary elements for the duration of the gesture.
		const selectedIds = getExcalidrawApi(leaf)?.getAppState().selectedElementIds ?? {};
		const needed = new Set<string>();
		for (const [elementId, embeddableIds] of overlaps) {
			if (!selectedIds[elementId]) continue;
			for (const id of embeddableIds) needed.add(id);
		}

		for (const id of state.dimmed) {
			if (!needed.has(id)) {
				const node = containers.get(id);
				if (node) setEmbeddableDimmed(node, false);
				state.dimmed.delete(id);
			}
		}
		for (const id of needed) {
			if (!state.dimmed.has(id)) {
				const node = containers.get(id);
				if (!node) continue;
				setEmbeddableDimmed(node, true);
				state.dimmed.add(id);
			}
		}
		// The frozen bitmap is stale the instant a gesture starts -- it isn't
		// re-rasterized until the gesture ends (see the at-rest branch below).
		// If the thing being dragged/resized is itself one of the elements
		// baked into that bitmap, drawing it would show a ghost at its
		// pre-drag position alongside Excalidraw's own live rendering of it at
		// its current position. `needed`-driven dimming alone doesn't catch
		// this: it only covers embeddables currently overlapped, not a
		// selected candidate that's been dragged clear of every embeddable.
		state.overlaySuppressed = needed.size > 0 || state.raster.ids.some((id) => selectedIds[id]);
		const viewport = currentViewport(leaf);
		if (viewport) repaint(state, viewport);
		return;
	}

	state.overlaySuppressed = false;

	// At rest: restore anything still dimmed from a gesture that just ended,
	// then rasterize the current candidate set onto the overlay.
	for (const id of state.dimmed) {
		const node = containers.get(id);
		if (node) setEmbeddableDimmed(node, false);
	}
	state.dimmed.clear();

	const byId = new Map(elements.map((element) => [element.id, element]));
	const candidates = [...overlaps.keys()].map((id) => byId.get(id)).filter((el): el is FrontOfEmbedElement => !!el);

	if (candidates.length === 0) {
		state.raster.bitmap?.close();
		state.raster = { key: null, pendingKey: null, token: state.raster.token + 1, bitmap: null, bounds: null, ids: [] };
	} else {
		rasterize(leaf, state, candidates);
	}
	const viewport = currentViewport(leaf);
	if (viewport) repaint(state, viewport);
}

function teardown(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	(windowOf(leaf) ?? window).cancelAnimationFrame(state.rafHandle);
	state.resizeObserver.disconnect();
	state.detachPointer();
	if (state.dimmed.size > 0) {
		const elements = readSceneElements(leaf) as readonly FrontOfEmbedElement[] | null;
		const containers = elements ? mapEmbeddableContainers(state.root, elements) : new Map<string, HTMLElement>();
		for (const id of state.dimmed) {
			const node = containers.get(id);
			if (node) setEmbeddableDimmed(node, false);
		}
	}
	state.raster.bitmap?.close();
	state.raster = { key: null, pendingKey: null, token: state.raster.token + 1, bitmap: null, bounds: null, ids: [] };
	state.canvas.remove();
}

/** Installs Front-of-embed rendering across every Excalidraw view -- main window and Popouts alike. Returns a dispose function. */
export function attachFrontOfEmbedRendering(plugin: ExcalidrawPureRefPlugin): () => void {
	return attachPerLeafScanner<FrontOfEmbedState>(plugin, { setup, scan, teardown });
}
