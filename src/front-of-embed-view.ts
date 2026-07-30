import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	curveControlPoints,
	maskDilation,
	maskPlacement,
	maskShapeFor,
	planFrontOfEmbedCandidates,
	type AbsoluteBounds,
	type FrontOfEmbedElement,
	type MaskPlacement,
	type MaskShape,
} from "./front-of-embed";
import {
	fetchEmittedGeometry,
	geometrySignature,
	hasEmittablePaths,
	type SvgExporter,
} from "./emitted-geometry";
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

/**
 * EXPERIMENT (see emitted-geometry.ts): one element's geometry as Excalidraw
 * itself emitted it, already parsed into `Path2D`. `signature` is what it was
 * built from, so a stale entry is never drawn.
 */
interface EmittedEntry {
	signature: string;
	paths: Array<{ path: Path2D; filled: boolean; strokeWidth: number | null; dash: readonly number[] | null }>;
}

interface FrontOfEmbedState {
	root: HTMLElement;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	/**
	 * Recomputed on every scene change (see `scan`), read by every frame.
	 * `signature` is the element's geometry as of that scan, so a frame can tell a
	 * cached export apart from a stale one without re-deriving it.
	 */
	candidates: ReadonlyArray<{
		element: FrontOfEmbedElement;
		mask: MaskShape;
		placement: MaskPlacement;
		signature: string;
	}>;
	/** Emitted geometry per element id, filled in asynchronously; empty until it resolves. */
	emitted: Map<string, EmittedEntry>;
	/** Signatures already being fetched, so a drag doesn't queue the same export repeatedly. */
	inFlight: Set<string>;
	/** Whether the overlay currently has anything painted, so idle frames can skip the clear. */
	painted: boolean;
	rafHandle: number;
}

/** Minimal shape of the `window.ExcalidrawLib` global the Excalidraw plugin injects per-window (PackageManager.ts). */
interface ExcalidrawLibGlobal {
	/** `[minX, minY, maxX, maxY]`, rotation-aware -- see `absoluteBoundsOf`. */
	getCommonBounds?(elements: readonly unknown[]): readonly number[];
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
 * `roundRect` isn't declared in this project's pinned TypeScript lib, though
 * every Chromium Obsidian ships on has had it since 99. Declared optional so the
 * one call site falls back to a square-cornered `rect` rather than throwing if it
 * ever isn't there.
 */
type RoundRectCapableContext = CanvasRenderingContext2D & {
	roundRect?(x: number, y: number, width: number, height: number, radii: number): void;
};

/** Straight-segment path through a point list, closed. */
function tracePolygon(ctx: CanvasRenderingContext2D, points: readonly (readonly number[])[]): void {
	const first = points[0];
	if (!first) return;
	ctx.moveTo(first[0] ?? 0, first[1] ?? 0);
	for (let i = 1; i < points.length; i++) {
		const point = points[i];
		if (point) ctx.lineTo(point[0] ?? 0, point[1] ?? 0);
	}
	ctx.closePath();
}

/**
 * The freedraw outline as Excalidraw draws it: quadratics whose control point is
 * each outline point and whose endpoint is the midpoint to the next one. This is
 * `getSvgPathFromStroke` rewritten in canvas calls -- its `T` (smooth quadratic)
 * commands reflect to exactly this, since the reflection of the previous control
 * point about a midpoint is the next point itself.
 */
function traceStrokeOutline(ctx: CanvasRenderingContext2D, points: readonly (readonly number[])[]): void {
	const at = (index: number): readonly [number, number] => {
		const point = points[index % points.length];
		return [point?.[0] ?? 0, point?.[1] ?? 0];
	};
	const midpoint = (a: readonly [number, number], b: readonly [number, number]): [number, number] => [
		(a[0] + b[0]) / 2,
		(a[1] + b[1]) / 2,
	];
	const start = at(0);
	ctx.moveTo(start[0], start[1]);
	for (let i = 1; i < points.length; i++) {
		const control = at(i);
		const end = midpoint(control, at(i + 1));
		ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
	}
	ctx.closePath();
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
		ctx.lineWidth = maskDilation(zoom, 0) * 2;
		const baseline = textBaselineOffset(lib, mask.fontFamily, mask.fontSize, mask.lineHeightPx);
		mask.lines.forEach((line, index) => {
			const y = index * mask.lineHeightPx + baseline;
			ctx.fillText(line, mask.horizontalOffset, y);
			ctx.strokeText(line, mask.horizontalOffset, y);
		});
		return;
	}

	if (mask.kind === "rough") {
		if (mask.fillRadius > 0) {
			// A rounded rectangle's interior: filling its bounding box instead would put
			// the four background triangles back outside the drawn corner arcs.
			const rounded = ctx as RoundRectCapableContext;
			ctx.beginPath();
			const radius = Math.min(mask.fillRadius, Math.abs(width) / 2, Math.abs(height) / 2);
			if (rounded.roundRect) rounded.roundRect(0, 0, width, height, radius);
			else ctx.rect(0, 0, width, height);
			ctx.fill();
		} else if (mask.fillPoints) {
			ctx.beginPath();
			tracePolygon(ctx, mask.fillPoints);
			ctx.fill();
		}
		ctx.beginPath();
		for (const op of mask.ops) {
			if (op.op === "move") ctx.moveTo(op.data[0], op.data[1]);
			else ctx.bezierCurveTo(op.data[0], op.data[1], op.data[2], op.data[3], op.data[4], op.data[5]);
		}
		// No jitter allowance: this path *is* where rough.js drew, so the only slack
		// needed is for the antialiased edge.
		ctx.lineWidth = mask.strokeWidth + maskDilation(zoom, 0) * 2;
		if (mask.dash) ctx.setLineDash(mask.dash as number[]);
		ctx.stroke();
		if (mask.dash) ctx.setLineDash([]);
		return;
	}

	if (mask.kind === "outline") {
		// Excalidraw fills this polygon as chained quadratics through the midpoints
		// between successive points (its `getSvgPathFromStroke`), which is what makes
		// the stroke smooth at any zoom rather than faceted. Tracing the polygon with
		// straight segments instead would put the mask's own corners back.
		if (mask.interior) {
			ctx.beginPath();
			tracePolygon(ctx, mask.interior);
			ctx.fill();
		}
		ctx.beginPath();
		traceStrokeOutline(ctx, mask.points);
		ctx.fill();
		// The outline is exact, so it needs the antialias allowance only.
		ctx.lineWidth = maskDilation(zoom, 0) * 2;
		ctx.stroke();
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
			// The exact Catmull-Rom-to-Bezier conversion rough.js draws a curved linear
			// element with, so the mask follows the stroke rather than merely resembling
			// it -- see `curveControlPoints`.
			for (const { cp1, cp2, to } of curveControlPoints(points)) {
				ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], to[0], to[1]);
			}
		} else {
			for (let i = 1; i < points.length; i++) {
				const point = points[i];
				if (point) ctx.lineTo(point[0], point[1]);
			}
		}
		if (mask.closed) ctx.closePath();
	}
	if (mask.fill) ctx.fill();
	ctx.lineWidth = mask.strokeWidth + maskDilation(zoom, mask.roughness) * 2;
	// A dashed or dotted stroke leaves real gaps; masking it solid paints scene
	// background into every one of them. The pattern is in scene units, and the
	// context is already scaled by zoom, so it needs no conversion.
	if (mask.dash) ctx.setLineDash(mask.dash as number[]);
	ctx.stroke();
	if (mask.dash) ctx.setLineDash([]);
}

/**
 * EXPERIMENT (see emitted-geometry.ts): masks an element from the paths
 * Excalidraw itself emitted, rather than from a reconstruction. Each path is
 * filled or stroked exactly as Excalidraw marked it, so this needs no shape
 * knowledge at all -- and no jitter allowance, since the path is the drawing.
 */
function paintEmitted(ctx: CanvasRenderingContext2D, entry: EmittedEntry, zoom: number): void {
	for (const { path, filled, strokeWidth, dash } of entry.paths) {
		if (filled) ctx.fill(path);
		if (strokeWidth === null) continue;
		ctx.lineWidth = strokeWidth + maskDilation(zoom, 0) * 2;
		if (dash) ctx.setLineDash(dash as number[]);
		ctx.stroke(path);
		if (dash) ctx.setLineDash([]);
	}
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
		return;
	}
	if (state.root.lastElementChild !== state.canvas) state.root.appendChild(state.canvas);
}

/** Composites the overlay for one frame: mask the qualifying elements, then blit Excalidraw's own pixels through it. */
function paint(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	const { ctx, canvas } = state;

	const api = getExcalidrawApi(leaf);
	const staticCanvas = state.root.querySelector<HTMLCanvasElement>(STATIC_CANVAS_SELECTOR);
	if (state.candidates.length === 0 || !api?.getAppState || !staticCanvas) {
		if (state.painted) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			state.painted = false;
		}
		return;
	}

	// Matched to the source bitmap rather than recomputed from clientWidth * dpr:
	// the two disagree by a pixel at fractional device ratios (818 * 1.25 rounds to
	// 1023 where Excalidraw's canvas is 1022), and that pixel became a stretch
	// across the whole blit, sliding every copied pixel off the element it came
	// from. Same size means `drawImage` at the identity transform is an exact copy.
	if (canvas.width !== staticCanvas.width || canvas.height !== staticCanvas.height) {
		canvas.width = staticCanvas.width;
		canvas.height = staticCanvas.height;
	}

	const appState = api.getAppState();
	const zoom = appState.zoom.value;
	const { scrollX, scrollY } = appState;
	const cssWidth = state.root.clientWidth;
	const cssHeight = state.root.clientHeight;
	// The scale Excalidraw *drew* with, which is what the masks have to agree with.
	// Deliberately not `canvas.width / cssWidth`: Excalidraw scales its context by
	// devicePixelRatio and then rounds the bitmap down, so the ratio of the two is
	// a slightly different number than the one its own strokes were placed by.
	const dpr = (windowOf(leaf) ?? window).devicePixelRatio || 1;
	const lib = windowOf(leaf)?.ExcalidrawLib;

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.clearRect(0, 0, cssWidth, cssHeight);
	ctx.fillStyle = "#000";
	ctx.strokeStyle = "#000";
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	for (const { element, mask, placement, signature } of state.candidates) {
		// Only a cache entry built from *this* geometry may be drawn. Without the
		// signature check a resize would keep masking the element's previous size
		// until its re-export landed, instead of falling back to the shape below.
		const cached = useEmittedGeometry ? state.emitted.get(element.id) : undefined;
		const emitted = cached?.signature === signature ? cached : undefined;
		ctx.save();
		// Element-local -> viewport: place the element's origin, scale to zoom, then
		// rotate about its centre, matching how Excalidraw itself transforms it.
		// Note there is no offsetLeft/offsetTop term: appState's offsets are the
		// `.excalidraw` root's own page position, and this canvas is a child of that
		// root (`inset: 0`), so its coordinates are already root-local.
		ctx.translate((element.x + scrollX) * zoom, (element.y + scrollY) * zoom);
		ctx.scale(zoom, zoom);
		// Rotate about the centre of the element's drawn bounds, then displace the
		// mask exactly as Excalidraw displaces the element itself -- see
		// `maskPlacement`. Neither term is `width/2, height/2` for a linear element.
		ctx.translate(placement.pivotX, placement.pivotY);
		ctx.rotate(element.angle ?? 0);
		ctx.translate(-placement.pivotX + placement.shiftX, -placement.pivotY + placement.shiftY);
		if (emitted) paintEmitted(ctx, emitted, zoom);
		else paintMask(ctx, mask, element, zoom, lib);
		ctx.restore();
	}

	// Everything painted above is now just a stencil: keep Excalidraw's own
	// rendered pixels only where the mask covered them.
	ctx.globalCompositeOperation = "source-in";
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.drawImage(staticCanvas, 0, 0);
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

/**
 * EXPERIMENT (see emitted-geometry.ts). Flip with `__eprEmittedGeometry(false)`
 * from the console to A/B this against the synchronous ports without a rebuild.
 */
let useEmittedGeometry = true;

/**
 * Asks Excalidraw for the geometry of any candidate whose own geometry has
 * changed since it was last asked. Keyed on that geometry rather than on the
 * element's version, so a drag -- which fires a scene change per pointer move --
 * re-exports nothing.
 */
function refreshEmittedGeometry(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	if (!useEmittedGeometry) return;
	const exporter = windowOf(leaf)?.ExcalidrawLib as SvgExporter | undefined;
	if (!exporter?.exportToSvg) return;
	// Path2D isn't on this project's pinned Window type, but a Popout needs its own
	// window's constructor, not the main one's.
	const win = (windowOf(leaf) ?? window) as unknown as { Path2D: new (d: string) => Path2D };

	const live = new Set<string>();
	for (const { element, signature } of state.candidates) {
		live.add(element.id);
		if (!hasEmittablePaths(element)) continue;
		if (state.emitted.get(element.id)?.signature === signature) continue;
		const key = `${element.id}:${signature}`;
		if (state.inFlight.has(key)) continue;
		state.inFlight.add(key);
		void fetchEmittedGeometry(exporter, element)
			.then((paths) => {
				state.emitted.set(element.id, {
					signature,
					paths: paths.map((emitted) => ({
						path: new win.Path2D(emitted.d),
						filled: emitted.filled,
						strokeWidth: emitted.strokeWidth,
						dash: emitted.dash,
					})),
				});
			})
			.catch(() => {
				// Leave the entry absent; the synchronous mask keeps covering it.
			})
			.finally(() => state.inFlight.delete(key));
	}
	// Elements that stopped qualifying shouldn't hold their geometry forever.
	for (const id of Array.from(state.emitted.keys())) if (!live.has(id)) state.emitted.delete(id);
}

/**
 * The element's own unrotated bounds, straight from Excalidraw -- the input
 * `maskPlacement` needs, and the only place they can come from: they're the
 * bounds of the drawn curve, jitter and all, which nothing outside Excalidraw
 * knows. `getCommonBounds` is rotation-aware where the canvas placement is not,
 * so a rotated element is measured through an unrotated copy.
 */
function absoluteBoundsOf(lib: ExcalidrawLibGlobal | undefined, element: FrontOfEmbedElement): AbsoluteBounds | null {
	if (!lib?.getCommonBounds) return null;
	const bounds = lib.getCommonBounds([element.angle ? { ...element, angle: 0 } : element]);
	if (!bounds || bounds.length < 4 || bounds.some((value) => !Number.isFinite(value))) return null;
	return { minX: bounds[0] as number, minY: bounds[1] as number, maxX: bounds[2] as number, maxY: bounds[3] as number };
}

/** Which elements need masking, with what shape, and placed where. Cheap enough to redo per scene change; never per frame. */
function planCandidates(leaf: WorkspaceLeaf): FrontOfEmbedState["candidates"] {
	const elements = readSceneElements(leaf) as readonly FrontOfEmbedElement[] | null;
	if (!elements) return [];
	const lib = windowOf(leaf)?.ExcalidrawLib;
	return planFrontOfEmbedCandidates(elements).map((element) => ({
		element,
		mask: maskShapeFor(element),
		placement: maskPlacement(element, absoluteBoundsOf(lib, element)),
		signature: geometrySignature(element),
	}));
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

	// No ResizeObserver: `paint` sizes the bitmap from Excalidraw's static canvas on
	// the frame it needs it, which is the only size that can ever be correct, and
	// the loop is idle whenever there's nothing to draw at any size.
	const state: FrontOfEmbedState = {
		root,
		canvas,
		ctx,
		candidates: planCandidates(leaf),
		emitted: new Map(),
		inFlight: new Set(),
		painted: false,
		rafHandle: 0,
	};

	refreshEmittedGeometry(leaf, state);
	startLoop(leaf, state, scanner);
	return state;
}

function scan(leaf: WorkspaceLeaf, state: FrontOfEmbedState, scanner: LeafScannerHandle<FrontOfEmbedState>): void {
	const had = state.candidates.length > 0 || state.painted;
	state.candidates = planCandidates(leaf);
	refreshEmittedGeometry(leaf, state);
	// Restart the loop when candidates appear, and for one final clearing frame
	// when the last one disappears.
	if (state.candidates.length > 0 || had) startLoop(leaf, state, scanner);
}

function teardown(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
	(windowOf(leaf) ?? window).cancelAnimationFrame(state.rafHandle);
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
	const host = window as unknown as { __eprFrontOfEmbed?: unknown; __eprEmittedGeometry?: unknown };
	// EXPERIMENT: `__eprEmittedGeometry(false)` switches back to the synchronous
	// ports without a rebuild, so the two can be compared on the same board.
	host.__eprEmittedGeometry = (on?: boolean) => {
		if (on !== undefined) {
			useEmittedGeometry = on;
			if (!on) for (const [, state] of scanner.entries()) state.emitted.clear();
		}
		return useEmittedGeometry;
	};
	host.__eprFrontOfEmbed = () =>
		scanner.entries().map(([, state]) => ({
			candidates: state.candidates.map(({ element }) => `${element.type}:${element.id.slice(0, 6)}`),
			emittedGeometry: useEmittedGeometry,
			emittedReady: state.emitted.size,
			emittedInFlight: state.inFlight.size,
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
			delete host.__eprEmittedGeometry;
		},
	];
}
