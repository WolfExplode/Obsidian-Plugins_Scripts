import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import { maskDilation, maskShapeFor, planFrontOfEmbedCandidates, type FrontOfEmbedElement, type MaskShape } from "./front-of-embed";
import { getExcalidrawApi, readSceneElements } from "./excalidraw-view";
import { attachPerLeafScanner, leafDocument, type LeafScannerApi, type LeafScannerHandle } from "./leaf-scanner";

/**
 * DOM/API glue for Front-of-embed rendering -- see
 * docs/behavior/front-of-embed-rendering.md and
 * docs/adr/0010-front-of-embed-rendering.md for the mechanism this implements.
 * front-of-embed.ts (pure, dependency-free) decides WHICH elements need the
 * treatment and WHAT SHAPE each one occludes; this file does the compositing.
 *
 * The whole mechanism is: Excalidraw has already rendered every one of those
 * elements into its own static canvas, this frame, at the current zoom, in the
 * current theme. So the overlay paints an alpha mask of the qualifying elements,
 * then copies Excalidraw's static canvas through it with `source-in`. Nothing is
 * re-rendered and nothing is cached -- the overlay is a masked copy of live
 * pixels, so it tracks drags, resizes, rotations, zooming and theme changes for
 * free, with no gesture handling of its own.
 *
 * Rides the same attach/prune/reconcile lifecycle as video-aspect.ts,
 * animated-image-drop.ts, and media-auto-pack.ts (attachPerLeafScanner in
 * leaf-scanner.ts) -- one registration covers the main window and every Popout,
 * attaching to views as they mount and detaching as they close.
 */

/**
 * Ties with Excalidraw's own embeddable containers (also z-index 2, verified
 * live) and with its interactive canvas, so DOM order decides -- which is why
 * the overlay is kept as the *last* child of the `.excalidraw` root (see
 * `ensureMounted`). Deliberately NOT 3: `--zIndex-svgLayer` and
 * `--zIndex-wysiwyg` are 3, and a later-in-DOM overlay at that level paints over
 * the in-place text editor.
 */
const OVERLAY_Z_INDEX = "2";

/** Excalidraw's own static scene canvas -- the source of every pixel this overlay draws. */
const STATIC_CANVAS_SELECTOR = "canvas.static";

interface FrontOfEmbedState {
	root: HTMLElement;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	resizeObserver: ResizeObserver;
	/** Recomputed on every scene change (see `scan`), read by every frame. */
	candidates: ReadonlyArray<{ element: FrontOfEmbedElement; mask: MaskShape }>;
	/** Whether the overlay currently has anything painted, so idle frames can skip the clear. */
	painted: boolean;
	rafHandle: number;
}

/** Minimal shape of the `window.ExcalidrawLib` global the Excalidraw plugin injects per-window (PackageManager.ts). */
interface ExcalidrawLibGlobal {
	getFontString?(opts: { fontSize: number; fontFamily: number }): string;
	getFontMetrics?(
		fontFamily: number,
		fontSize?: number,
	): { unitsPerEm: number; ascender: number; descender: number; lineHeight: number } | undefined;
}

function windowOf(leaf: WorkspaceLeaf): (Window & { ExcalidrawLib?: ExcalidrawLibGlobal }) | null {
	return (leafDocument(leaf)?.defaultView as (Window & { ExcalidrawLib?: ExcalidrawLibGlobal }) | null) ?? null;
}

function findExcalidrawRoot(leaf: WorkspaceLeaf): HTMLElement | null {
	const containerEl = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
	return containerEl?.querySelector<HTMLElement>(".excalidraw") ?? null;
}

/**
 * The vertical offset from an element's top edge to its first line's alphabetic
 * baseline, matching Excalidraw's own `getVerticalOffset`
 * (packages/element/src/renderElement.ts) exactly so the mask lands on the
 * glyphs. Falls back to a rough half-line-height estimate if the bundled fork
 * doesn't expose font metrics -- the mask is dilated, so a few units of error
 * costs a slightly loose fit rather than a clipped glyph.
 */
function textBaselineOffset(
	lib: ExcalidrawLibGlobal | undefined,
	fontFamily: number,
	fontSize: number,
	lineHeightPx: number,
): number {
	const metrics = lib?.getFontMetrics?.(fontFamily, fontSize);
	if (!metrics?.unitsPerEm) return (lineHeightPx + fontSize) / 2;
	const fontSizeEm = fontSize / metrics.unitsPerEm;
	const lineGap = (lineHeightPx - fontSizeEm * metrics.ascender + fontSizeEm * metrics.descender) / 2;
	return fontSizeEm * metrics.ascender + lineGap;
}

/**
 * Paints one element's occluded region, opaque, in element-local coordinates.
 * Only the alpha matters -- the colour is discarded by the `source-in` blit that
 * replaces these pixels with Excalidraw's own.
 */
function paintMask(
	ctx: CanvasRenderingContext2D,
	mask: MaskShape,
	element: FrontOfEmbedElement,
	zoom: number,
	lib: ExcalidrawLibGlobal | undefined,
): void {
	const { width, height } = element;

	if (mask.kind === "box") {
		ctx.fillRect(0, 0, width, height);
		return;
	}

	if (mask.kind === "text") {
		ctx.font = lib?.getFontString?.({ fontSize: mask.fontSize, fontFamily: mask.fontFamily }) ?? `${mask.fontSize}px sans-serif`;
		ctx.textAlign = mask.textAlign;
		// strokeText over fillText dilates the glyphs enough to cover their
		// antialiased edges; without it the blit clips a hairline off every letter.
		// Text carries no rough.js jitter, so it gets the antialias allowance only.
		ctx.lineWidth = maskDilation(zoom, false) * 2;
		const baseline = textBaselineOffset(lib, mask.fontFamily, mask.fontSize, mask.lineHeightPx);
		mask.lines.forEach((line, index) => {
			const y = index * mask.lineHeightPx + baseline;
			ctx.fillText(line, mask.horizontalOffset, y);
			ctx.strokeText(line, mask.horizontalOffset, y);
		});
		return;
	}

	ctx.beginPath();
	if (mask.kind === "ellipse") {
		ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
	} else {
		const points = mask.points.map((point) => [point[0] ?? 0, point[1] ?? 0] as const);
		const first = points[0];
		const last = points[points.length - 1];
		if (!first || !last) return;
		ctx.moveTo(first[0], first[1]);
		if (mask.smooth && points.length > 2) {
			// Quadratic through the midpoints between successive control points: the
			// standard smoothing that approximates the cardinal spline rough.js draws
			// for a curved line/arrow, close enough to stay inside the dilation.
			for (let i = 1; i < points.length - 1; i++) {
				const point = points[i];
				const next = points[i + 1];
				if (!point || !next) continue;
				ctx.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
			}
			ctx.lineTo(last[0], last[1]);
		} else {
			for (let i = 1; i < points.length; i++) {
				const point = points[i];
				if (point) ctx.lineTo(point[0], point[1]);
			}
		}
		if (mask.closed) ctx.closePath();
	}
	if (mask.fill) ctx.fill();
	ctx.lineWidth = mask.strokeWidth + maskDilation(zoom, true) * 2;
	ctx.stroke();
}

/**
 * Re-attaches the overlay if Excalidraw replaced its root (a mode switch does
 * this without closing the leaf) and keeps it the last child of that root:
 * embeddable containers share the overlay's z-index, so being appended after
 * them is what puts the overlay on top, and React appends a newly-mounted
 * embeddable to the same parent.
 */
function ensureMounted(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	if (!state.canvas.isConnected) {
		const root = findExcalidrawRoot(leaf);
		if (!root) return;
		state.root = root;
		root.appendChild(state.canvas);
		state.resizeObserver.disconnect();
		state.resizeObserver.observe(root);
		return;
	}
	if (state.root.lastElementChild !== state.canvas) state.root.appendChild(state.canvas);
}

/** Composites the overlay for one frame: mask the qualifying elements, then blit Excalidraw's own pixels through it. */
function paint(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	const { ctx, canvas } = state;
	const width = canvas.width;
	const height = canvas.height;

	const api = getExcalidrawApi(leaf);
	const staticCanvas = state.root.querySelector<HTMLCanvasElement>(STATIC_CANVAS_SELECTOR);
	if (state.candidates.length === 0 || !api?.getAppState || !staticCanvas) {
		if (state.painted) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, width, height);
			state.painted = false;
		}
		return;
	}

	const appState = api.getAppState();
	const zoom = appState.zoom.value;
	const { scrollX, scrollY } = appState;
	const cssWidth = state.root.clientWidth;
	const cssHeight = state.root.clientHeight;
	const dpr = width / Math.max(1, cssWidth);
	const lib = windowOf(leaf)?.ExcalidrawLib;

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.clearRect(0, 0, cssWidth, cssHeight);
	ctx.fillStyle = "#000";
	ctx.strokeStyle = "#000";
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	for (const { element, mask } of state.candidates) {
		ctx.save();
		// Element-local -> viewport: place the element's origin, scale to zoom, then
		// rotate about its centre, matching how Excalidraw itself transforms it.
		// Note there is no offsetLeft/offsetTop term: appState's offsets are the
		// `.excalidraw` root's own page position, and this canvas is a child of that
		// root (`inset: 0`), so its coordinates are already root-local.
		ctx.translate((element.x + scrollX) * zoom, (element.y + scrollY) * zoom);
		ctx.scale(zoom, zoom);
		ctx.translate(element.width / 2, element.height / 2);
		ctx.rotate(element.angle ?? 0);
		ctx.translate(-element.width / 2, -element.height / 2);
		paintMask(ctx, mask, element, zoom, lib);
		ctx.restore();
	}

	// Everything painted above is now just a stencil: keep Excalidraw's own
	// rendered pixels only where the mask covered them.
	ctx.globalCompositeOperation = "source-in";
	ctx.drawImage(staticCanvas, 0, 0, cssWidth, cssHeight);
	ctx.globalCompositeOperation = "source-over";
	state.painted = true;
}

/**
 * The compositing loop, which runs only while the overlay has something to draw.
 * It stops itself once the candidate set empties (after the frame that clears
 * what was on screen), and `scan` restarts it when candidates reappear -- so a
 * board with no element in front of an embeddable, which is most boards, costs
 * nothing per frame.
 */
function tick(leaf: WorkspaceLeaf, state: FrontOfEmbedState, scanner: LeafScannerHandle<FrontOfEmbedState>): void {
	if (scanner.isDisposed()) {
		state.rafHandle = 0;
		return;
	}
	ensureMounted(leaf, state);
	paint(leaf, state);
	if (state.candidates.length === 0) {
		state.rafHandle = 0;
		return;
	}
	state.rafHandle = (windowOf(leaf) ?? window).requestAnimationFrame(() => tick(leaf, state, scanner));
}

function startLoop(leaf: WorkspaceLeaf, state: FrontOfEmbedState, scanner: LeafScannerHandle<FrontOfEmbedState>): void {
	if (state.rafHandle !== 0) return;
	state.rafHandle = (windowOf(leaf) ?? window).requestAnimationFrame(() => tick(leaf, state, scanner));
}

/** Which elements need masking, and with what shape. Cheap enough to redo per scene change; never per frame. */
function planCandidates(leaf: WorkspaceLeaf): FrontOfEmbedState["candidates"] {
	const elements = readSceneElements(leaf) as readonly FrontOfEmbedElement[] | null;
	if (!elements) return [];
	return planFrontOfEmbedCandidates(elements).map((element) => ({ element, mask: maskShapeFor(element) }));
}

function setup(leaf: WorkspaceLeaf, _api: LeafScannerApi, scanner: LeafScannerHandle<FrontOfEmbedState>): FrontOfEmbedState | null {
	const root = findExcalidrawRoot(leaf);
	const win = windowOf(leaf);
	if (!root || !win) return null;

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
	if (!ctx) return null;

	const resize = () => {
		const dpr = win.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(state.root.clientWidth * dpr));
		const height = Math.max(1, Math.round(state.root.clientHeight * dpr));
		if (canvas.width === width && canvas.height === height) return;
		canvas.width = width;
		canvas.height = height;
		// The resize cleared the bitmap; the next frame repaints it unconditionally.
		state.painted = false;
	};
	// Not window-scoped: ResizeObserver's constructor isn't declared on the Window
	// interface in this project's pinned TypeScript/lib version, and observing a
	// Popout's DOM node works fine via the global constructor.
	const resizeObserver = new ResizeObserver(resize);

	const state: FrontOfEmbedState = {
		root,
		canvas,
		ctx,
		resizeObserver,
		candidates: planCandidates(leaf),
		painted: false,
		rafHandle: 0,
	};

	resize();
	resizeObserver.observe(root);
	startLoop(leaf, state, scanner);
	return state;
}

function scan(leaf: WorkspaceLeaf, state: FrontOfEmbedState, scanner: LeafScannerHandle<FrontOfEmbedState>): void {
	const had = state.candidates.length > 0 || state.painted;
	state.candidates = planCandidates(leaf);
	// Restart the loop when candidates appear, and for one final clearing frame
	// when the last one disappears.
	if (state.candidates.length > 0 || had) startLoop(leaf, state, scanner);
}

function teardown(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	(windowOf(leaf) ?? window).cancelAnimationFrame(state.rafHandle);
	state.resizeObserver.disconnect();
	state.candidates = [];
	state.canvas.remove();
}

/** Installs Front-of-embed rendering across every Excalidraw view -- main window and Popouts alike. Returns a dispose function. */
export function attachFrontOfEmbedRendering(plugin: ExcalidrawPureRefPlugin): () => void {
	const dispose = attachPerLeafScanner<FrontOfEmbedState>(plugin, { setup, scan, teardown, extras: installDebugHook });
	return dispose;
}

/**
 * Mirrors the console hook pattern `crop-drag.ts` already uses
 * (`window.__eprCropDebug`): a read-only view of each attached leaf's overlay
 * state, so "is the compositing loop actually running?" can be answered from the
 * devtools console without instrumenting a build.
 */
function installDebugHook(scanner: LeafScannerHandle<FrontOfEmbedState>): Array<() => void> {
	const host = window as unknown as { __eprFrontOfEmbed?: unknown };
	host.__eprFrontOfEmbed = () =>
		scanner.entries().map(([, state]) => ({
			candidates: state.candidates.map(({ element }) => `${element.type}:${element.id.slice(0, 6)}`),
			painted: state.painted,
			loopRunning: state.rafHandle !== 0,
			canvasConnected: state.canvas.isConnected,
			canvasIsLastChild: state.root.lastElementChild === state.canvas,
			rootConnected: state.root.isConnected,
			canvasSize: [state.canvas.width, state.canvas.height],
		}));
	return [
		() => {
			delete host.__eprFrontOfEmbed;
		},
	];
}
