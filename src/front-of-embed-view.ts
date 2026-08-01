import type { WorkspaceLeaf } from "obsidian";
import type ExcalidrawPureRefPlugin from "../main";
import {
	elementPlacement,
	isFrontOfEmbedEmbeddable,
	paintPlanFor,
	planFrontOfEmbedCandidates,
	type AbsoluteBounds,
	type ElementPlacement,
	type FrontOfEmbedElement,
	type PaintPlan,
} from "./front-of-embed";
import { computeArrowLabelPosition } from "./arrow-label-position";
import {
	fetchEmittedGeometry,
	geometrySignature,
	hasEmittablePaths,
	type SvgExporter,
} from "./emitted-geometry";
import { elementAABB, type Rect } from "./pack-elements";
import { getExcalidrawApi, readSceneElements } from "./excalidraw-view";
import { attachPerLeafScanner, leafDocument, type LeafScannerApi, type LeafScannerHandle } from "./leaf-scanner";

/**
 * DOM/API glue for Front-of-embed rendering -- see
 * docs/behavior/front-of-embed-rendering.md and
 * docs/adr/0010-front-of-embed-rendering.md for the mechanism this implements.
 * front-of-embed.ts (pure, dependency-free) decides WHICH elements need the
 * treatment and HOW each one is painted; this file does the compositing.
 *
 * The whole mechanism is: paint the qualifying elements onto an overlay canvas
 * that sits above the embeddables, every frame, under the live scene transform.
 * Two ways of painting, see `paint`:
 *
 * - **Drawn** -- the paths Excalidraw itself emitted for the element, stroked
 *   and filled in the colours it emitted them with (plus text as glyphs). This
 *   copies nothing, which is the whole point: the overlay carries the element
 *   and nothing else, so it deposits no scene background over the embed and
 *   composites against the embed rather than against the board. Nothing is drawn
 *   until the element's export has landed -- an element mid-stroke or mid-resize
 *   stays behind the embeddable for those frames rather than being approximated.
 * - **Blitted** -- images only: paint the element's box as an alpha mask, then
 *   copy Excalidraw's own static canvas through it with `source-in`, because an
 *   image's pixels exist nowhere else. The box is exactly the image's extent, so
 *   this copy brings no scene background with it.
 *
 * Neither path holds a rendered snapshot, so drags, resizes, rotations and
 * zooming need no gesture handling: the transform is re-read every frame.
 *
 * Rides the same attach/prune/reconcile lifecycle as video-aspect.ts and
 * media-auto-pack.ts (attachPerLeafScanner in leaf-scanner.ts) -- one
 * registration covers the main window and every Popout, attaching to views as
 * they mount and detaching as they close.
 */

/** Excalidraw's own static scene canvas -- the source of every blitted pixel this overlay draws. */
const STATIC_CANVAS_SELECTOR = "canvas.static";

/**
 * Excalidraw's `DARK_THEME_FILTER`
 * ([constants.ts:194](../reference/excalidraw-master/packages/common/src/constants.ts#L194)),
 * which is how dark theme is implemented: not as a palette, but as a filter over
 * everything the scene draws. It is **baked into the canvas pixels**, not applied
 * as CSS -- verified live (2026-07-31): no element from the static canvas up to
 * the workspace leaf has a computed `filter`, yet `viewBackgroundColor` `#ffffff`
 * reads back as `18,18,18` and a `#1e1e1e` glyph reads back as `211,211,211`,
 * which is exactly `invert(93%)` of each.
 *
 * So the blit path inherits the theme for free (it copies pixels that already
 * went through it) and the drawn path must apply it itself, or a dark-theme board
 * gets black text where Excalidraw drew white.
 */
const DARK_THEME_FILTER = "invert(93%) hue-rotate(180deg)";

/**
 * One element's geometry as Excalidraw itself emitted it (see
 * emitted-geometry.ts), already parsed into `Path2D`. `signature` is what it was
 * built from, so a stale entry is never drawn.
 */
interface EmittedEntry {
	signature: string;
	paths: Array<{
		path: Path2D;
		filled: boolean;
		fill: string | null;
		strokeWidth: number | null;
		stroke: string | null;
		dash: readonly number[] | null;
	}>;
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
		plan: PaintPlan;
		placement: ElementPlacement;
		signature: string;
	}>;
	/**
	 * Where the overlay is allowed to paint: the embeddables it exists to cover, in
	 * scene coordinates. Recomputed alongside `candidates` -- see `paint` for why an
	 * unclipped overlay is wrong, not just untidy.
	 */
	clip: readonly Rect[];
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
 * Draws an element from the paths Excalidraw itself emitted, in the colours it
 * emitted them with -- the element itself, not a stencil. Each path is filled or
 * stroked exactly as Excalidraw marked it, so this needs no shape knowledge at
 * all, and no dilation: the edge antialiases against transparency and
 * composites onto the embed the way any drawn element would.
 */
function paintEmittedElement(ctx: CanvasRenderingContext2D, entry: EmittedEntry): void {
	for (const { path, filled, fill, strokeWidth, stroke, dash } of entry.paths) {
		if (filled) {
			ctx.fillStyle = fill ?? "#000";
			ctx.fill(path);
		}
		if (strokeWidth === null) continue;
		ctx.strokeStyle = stroke ?? "#000";
		ctx.lineWidth = strokeWidth;
		if (dash) ctx.setLineDash(dash as number[]);
		ctx.stroke(path);
		if (dash) ctx.setLineDash([]);
	}
}

/**
 * Draws text as glyphs in the element's own colour. Excalidraw has no path
 * geometry to emit for text (it exports `<text>`), so this is the one type whose
 * placement is computed here rather than read off an export -- but the placement
 * is Excalidraw's own (`textBaselineOffset` mirrors `getVerticalOffset`) and the
 * font string comes from `getFontString`, so the glyphs land where Excalidraw put
 * them.
 */
function paintTextElement(
	ctx: CanvasRenderingContext2D,
	plan: Extract<PaintPlan, { kind: "text" }>,
	element: FrontOfEmbedElement,
	lib: ExcalidrawLibGlobal | undefined,
): void {
	ctx.fillStyle = element.strokeColor ?? "#000";
	ctx.font = lib?.getFontString?.({ fontSize: plan.fontSize, fontFamily: plan.fontFamily }) ?? `${plan.fontSize}px sans-serif`;
	ctx.textAlign = plan.textAlign;
	const baseline = textBaselineOffset(lib, plan.fontFamily, plan.fontSize, plan.lineHeightPx);
	plan.lines.forEach((line, index) => {
		ctx.fillText(line, plan.horizontalOffset, index * plan.lineHeightPx + baseline);
	});
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

	// Element-local -> viewport: place the element's origin, scale to zoom, then
	// rotate about its centre, matching how Excalidraw itself transforms it.
	// Note there is no offsetLeft/offsetTop term: appState's offsets are the
	// `.excalidraw` root's own page position, and this canvas is a child of that
	// root (`inset: 0`), so its coordinates are already root-local.
	const placeElement = (element: FrontOfEmbedElement, placement: ElementPlacement): void => {
		ctx.translate((element.x + scrollX) * zoom, (element.y + scrollY) * zoom);
		ctx.scale(zoom, zoom);
		// Rotate about the centre of the element's drawn bounds, then displace the
		// paint exactly as Excalidraw displaces the element itself -- see
		// `elementPlacement`. Neither term is `width/2, height/2` for a linear element.
		ctx.translate(placement.pivotX, placement.pivotY);
		ctx.rotate(element.angle ?? 0);
		ctx.translate(-placement.pivotX + placement.shiftX, -placement.pivotY + placement.shiftY);
	};

	// Each candidate is either DRAWN (its own geometry, in its own colours) or
	// BLITTED (masked, then filled with a copy of Excalidraw's canvas). Drawing is
	// the whole mechanism: it copies nothing, so it deposits no scene background.
	// Blitting is images only, whose pixels can come from nowhere else.
	//
	// A candidate whose export hasn't landed is in NEITHER list -- it is skipped for
	// this frame and stays behind the embeddable until its geometry arrives. There
	// is deliberately no approximation to fall back to.
	const drawn: Array<{ element: FrontOfEmbedElement; placement: ElementPlacement; entry?: EmittedEntry; plan: PaintPlan }> = [];
	const blitted: typeof drawn = [];
	for (const { element, plan, placement, signature } of state.candidates) {
		if (plan.kind === "image") {
			blitted.push({ element, placement, plan });
			continue;
		}
		if (plan.kind === "text") {
			drawn.push({ element, placement, plan });
			continue;
		}
		// Only a cache entry built from *this* geometry may be used. Without the
		// signature check a resize would keep drawing the element's previous size
		// until its re-export landed.
		const cached = state.emitted.get(element.id);
		if (cached?.signature === signature) drawn.push({ element, placement, entry: cached, plan });
	}

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.clearRect(0, 0, cssWidth, cssHeight);
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	// Restricted to the embeddables, same reasoning as `frontLayerClipPath`: this
	// overlay is a *second* copy of elements the static canvas already drew.
	// Unclipped, every candidate is painted twice -- invisible where opaque, but a
	// semi-transparent or hachure-filled one composites against itself, and a
	// candidate covers any later element it overlaps away from the embeddable.
	// `clip()` freezes against the CTM at this call, in device pixels, so it holds
	// through pass 1's temporary identity transform below and through every
	// candidate's own translate/rotate in `placeElement`.
	ctx.save();
	ctx.beginPath();
	for (const rect of state.clip) {
		ctx.rect((rect.minX + scrollX) * zoom, (rect.minY + scrollY) * zoom, (rect.maxX - rect.minX) * zoom, (rect.maxY - rect.minY) * zoom);
	}
	ctx.clip();

	// Pass 1: the blitted candidates (images), as a stencil. An image's stencil is
	// its whole box -- exactly its extent, so the copy that fills it carries no
	// scene background across with it.
	if (blitted.length > 0) {
		ctx.fillStyle = "#000";
		for (const { element, placement } of blitted) {
			ctx.save();
			placeElement(element, placement);
			ctx.fillRect(0, 0, element.width, element.height);
			ctx.restore();
		}
		// That stencil is now filled with Excalidraw's own rendered pixels.
		ctx.globalCompositeOperation = "source-in";
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(staticCanvas, 0, 0);
		ctx.globalCompositeOperation = "source-over";
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	// Pass 2: the drawn candidates, over the top. `source-over` here is what makes
	// the split safe -- pass 1's `source-in` only ever consumed its own stencil, and
	// these are added afterwards rather than being caught by it.
	//
	// The theme filter goes on for this pass only: pass 1's pixels came off a canvas
	// that had already been through it, and filtering them twice would undo it.
	const themeFilter = appState.theme === "dark" ? DARK_THEME_FILTER : "none";
	for (const { element, plan, placement, entry } of drawn) {
		ctx.save();
		ctx.filter = themeFilter;
		placeElement(element, placement);
		// Excalidraw's 0-100 opacity, applied here rather than baked into the export
		// so dragging the opacity slider re-exports nothing.
		const opacity = element.opacity;
		if (typeof opacity === "number" && opacity < 100) ctx.globalAlpha = Math.max(0, opacity) / 100;
		if (entry) paintEmittedElement(ctx, entry);
		else if (plan.kind === "text") paintTextElement(ctx, plan, element, lib);
		ctx.globalAlpha = 1;
		ctx.restore();
	}

	ctx.restore(); // pairs with the clip's `save()` above
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
 * Asks Excalidraw for the geometry of any candidate whose own geometry has
 * changed since it was last asked. Keyed on that geometry rather than on the
 * element's version, so a drag -- which fires a scene change per pointer move --
 * re-exports nothing.
 */
function refreshEmittedGeometry(leaf: WorkspaceLeaf, state: FrontOfEmbedState): void {
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
						fill: emitted.fill,
						strokeWidth: emitted.strokeWidth,
						stroke: emitted.stroke,
						dash: emitted.dash,
					})),
				});
			})
			.catch(() => {
				// Leave the entry absent; the candidate is simply skipped until a later export succeeds.
			})
			.finally(() => state.inFlight.delete(key));
	}
	// Elements that stopped qualifying shouldn't hold their geometry forever.
	for (const id of Array.from(state.emitted.keys())) if (!live.has(id)) state.emitted.delete(id);
}

/**
 * The element's own unrotated bounds, straight from Excalidraw -- the input
 * `elementPlacement` needs, and the only place they can come from: they're the
 * bounds of the drawn curve, jitter and all, which nothing outside Excalidraw
 * knows. `getCommonBounds` is rotation-aware where the canvas placement is not,
 * so a rotated element is measured through an unrotated copy.
 */
function absoluteBoundsOf(lib: ExcalidrawLibGlobal | undefined, element: FrontOfEmbedElement): AbsoluteBounds | null {
	if (!lib?.getCommonBounds) return null;
	const bounds = lib.getCommonBounds([element.angle ? { ...element, angle: 0 } : element]);
	if (!bounds || bounds.length < 4 || bounds.some((value) => !Number.isFinite(value))) return null;
	return { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] };
}

type Candidate = { element: FrontOfEmbedElement; plan: PaintPlan; placement: ElementPlacement; signature: string };

/**
 * An arrow-bound label's stored `x`/`y`/`angle` aren't trustworthy (see
 * `isFrontOfEmbedEligible` in front-of-embed.ts) -- this returns a copy
 * repositioned onto the arrow's real, currently-drawn midpoint, or `null` when
 * that can't be computed this frame (the caller drops the candidate rather
 * than paint it at a stale position). Every other element passes through
 * unchanged.
 */
function resolveCandidateElement(
	element: FrontOfEmbedElement,
	byId: ReadonlyMap<string, FrontOfEmbedElement>,
	lib: ExcalidrawLibGlobal | undefined,
): FrontOfEmbedElement | null {
	if (!element.containerId) return element;
	const container = byId.get(element.containerId);
	if (container?.type !== "arrow") return element;
	const containerBounds = absoluteBoundsOf(lib, container);
	if (!containerBounds) return null;
	const position = computeArrowLabelPosition(container, containerBounds, element);
	if (!position) return null;
	return { ...element, x: position.x, y: position.y, angle: 0 };
}

/** Which elements go in front, how each is painted and placed, and where they're allowed to paint. Cheap enough to redo per scene change; never per frame. */
function planCandidates(leaf: WorkspaceLeaf): Pick<FrontOfEmbedState, "candidates" | "clip"> {
	const elements = readSceneElements(leaf) as readonly FrontOfEmbedElement[] | null;
	if (!elements) return { candidates: [], clip: [] };
	const lib = windowOf(leaf)?.ExcalidrawLib;
	const byId = new Map(elements.map((element) => [element.id, element] as const));
	const candidates: Candidate[] = [];
	for (const element of planFrontOfEmbedCandidates(elements)) {
		const resolved = resolveCandidateElement(element, byId, lib);
		if (!resolved) continue;
		candidates.push({
			element: resolved,
			plan: paintPlanFor(resolved),
			placement: elementPlacement(resolved, absoluteBoundsOf(lib, resolved)),
			signature: geometrySignature(resolved),
		});
	}
	// Same rule as `frontLayerClipPath`: a candidate exists only because it sits in
	// front of one of these, so an empty clip here would mean the two disagree --
	// paint nothing rather than paint unclipped.
	const clip = candidates.length > 0 ? elements.filter(isFrontOfEmbedEmbeddable).map(elementAABB) : [];
	return { candidates, clip };
}

function setup(leaf: WorkspaceLeaf, _api: LeafScannerApi, scanner: LeafScannerHandle<FrontOfEmbedState>): FrontOfEmbedState | null {
	const root = findExcalidrawRoot(leaf);
	const win = windowOf(leaf);
	if (!root || !win) return null;

	const canvas = root.createEl("canvas", { cls: "epr-front-of-embed-overlay" });

	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	// No ResizeObserver: `paint` sizes the bitmap from Excalidraw's static canvas on
	// the frame it needs it, which is the only size that can ever be correct, and
	// the loop is idle whenever there's nothing to draw at any size.
	const state: FrontOfEmbedState = {
		root,
		canvas,
		ctx,
		...planCandidates(leaf),
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
	Object.assign(state, planCandidates(leaf));
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
	const host = window as unknown as { __eprFrontOfEmbed?: unknown };
	host.__eprFrontOfEmbed = () =>
		scanner.entries().map(([, state]) => ({
			candidates: state.candidates.map(({ element }) => `${element.type}:${element.id.slice(0, 6)}`),
			emittedReady: state.emitted.size,
			emittedInFlight: state.inFlight.size,
			painted: state.painted,
			loopRunning: state.rafHandle !== 0,
			canvasConnected: state.canvas.isConnected,
			canvasIsLastChild: state.root.lastElementChild === state.canvas,
			rootConnected: state.root.isConnected,
			canvasSize: [state.canvas.width, state.canvas.height],
		}));
	return [() => delete host.__eprFrontOfEmbed];
}
