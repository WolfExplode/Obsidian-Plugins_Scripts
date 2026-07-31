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
 * The whole mechanism is: paint the qualifying elements onto an overlay canvas
 * that sits above the embeddables, every frame, under the live scene transform.
 * Two ways of painting, see `paint`:
 *
 * - **Drawn** -- the paths Excalidraw itself emitted for the element, stroked
 *   and filled in the colours it emitted them with (plus text as glyphs). This
 *   copies nothing, which is the whole point: the overlay carries the element
 *   and nothing else, so it deposits no scene background over the embed and
 *   composites against the embed rather than against the board.
 * - **Blitted** -- the original mechanism, kept for images and for the frame or
 *   two before an element's export lands: paint an alpha mask, then copy
 *   Excalidraw's own static canvas through it with `source-in`. Its cost is that
 *   the static canvas is opaque, so a mask wider than the element brings board
 *   background with it -- harmless for an image, whose mask is its own box.
 *
 * Neither path holds a rendered snapshot, so drags, resizes, rotations and
 * zooming need no gesture handling: the transform is re-read every frame.
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
 * EXPERIMENT (see emitted-geometry.ts): one element's geometry as Excalidraw
 * itself emitted it, already parsed into `Path2D`. `signature` is what it was
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
 * Draws an element from the paths Excalidraw itself emitted, in the colours it
 * emitted them with -- the element itself, not a stencil. Each path is filled or
 * stroked exactly as Excalidraw marked it, so this needs no shape knowledge at
 * all, and **no dilation**: dilation only ever existed to cover an opaque blit's
 * seam, and nothing is copied here. The edge antialiases against transparency
 * and composites onto the embed the way any drawn element would.
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
 * geometry to emit for text (it exports `<text>`), so this is the one type drawn
 * from reconstructed placement rather than from emitted paths -- but the
 * placement is Excalidraw's own (`textBaselineOffset` mirrors `getVerticalOffset`)
 * and the font string comes from `getFontString`, so the glyphs land where
 * Excalidraw put them. No `strokeText` pass and no dilation: that existed to stop
 * the blit clipping a hairline off each letter, and there is no blit here.
 */
function paintTextElement(
	ctx: CanvasRenderingContext2D,
	mask: Extract<MaskShape, { kind: "text" }>,
	element: FrontOfEmbedElement,
	lib: ExcalidrawLibGlobal | undefined,
): void {
	ctx.fillStyle = element.strokeColor ?? "#000";
	ctx.font = lib?.getFontString?.({ fontSize: mask.fontSize, fontFamily: mask.fontFamily }) ?? `${mask.fontSize}px sans-serif`;
	ctx.textAlign = mask.textAlign;
	const baseline = textBaselineOffset(lib, mask.fontFamily, mask.fontSize, mask.lineHeightPx);
	mask.lines.forEach((line, index) => {
		ctx.fillText(line, mask.horizontalOffset, index * mask.lineHeightPx + baseline);
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
	const placeElement = (element: FrontOfEmbedElement, placement: MaskPlacement): void => {
		ctx.translate((element.x + scrollX) * zoom, (element.y + scrollY) * zoom);
		ctx.scale(zoom, zoom);
		// Rotate about the centre of the element's drawn bounds, then displace the
		// mask exactly as Excalidraw displaces the element itself -- see
		// `maskPlacement`. Neither term is `width/2, height/2` for a linear element.
		ctx.translate(placement.pivotX, placement.pivotY);
		ctx.rotate(element.angle ?? 0);
		ctx.translate(-placement.pivotX + placement.shiftX, -placement.pivotY + placement.shiftY);
	};

	// Each candidate is either DRAWN (its own geometry, in its own colours) or
	// BLITTED (masked, then filled with a copy of Excalidraw's canvas). Drawing is
	// the good path -- it copies nothing, so it deposits no scene background -- and
	// covers every type whose geometry Excalidraw will emit, plus text. Blitting is
	// left for images, whose pixels can only come from the canvas, and for the frame
	// or two before an element's export lands.
	const drawn: Array<{ element: FrontOfEmbedElement; placement: MaskPlacement; entry?: EmittedEntry; mask: MaskShape }> = [];
	const blitted: typeof drawn = [];
	for (const { element, mask, placement, signature } of state.candidates) {
		// Only a cache entry built from *this* geometry may be used. Without the
		// signature check a resize would keep drawing the element's previous size
		// until its re-export landed, instead of falling back to the mask below.
		const cached = useEmittedGeometry ? state.emitted.get(element.id) : undefined;
		const entry = cached?.signature === signature ? cached : undefined;
		if (entry) drawn.push({ element, placement, entry, mask });
		else if (mask.kind === "text") drawn.push({ element, placement, mask });
		else blitted.push({ element, placement, mask });
	}

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.clearRect(0, 0, cssWidth, cssHeight);
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	// Pass 1: the blitted candidates, as a stencil.
	if (blitted.length > 0) {
		ctx.fillStyle = "#000";
		ctx.strokeStyle = "#000";
		for (const { element, mask, placement } of blitted) {
			ctx.save();
			placeElement(element, placement);
			paintMask(ctx, mask, element, zoom, lib);
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
	for (const { element, mask, placement, entry } of drawn) {
		ctx.save();
		ctx.filter = themeFilter;
		placeElement(element, placement);
		// Excalidraw's 0-100 opacity, applied here rather than baked into the export
		// so dragging the opacity slider re-exports nothing.
		const opacity = element.opacity;
		if (typeof opacity === "number" && opacity < 100) ctx.globalAlpha = Math.max(0, opacity) / 100;
		if (entry) paintEmittedElement(ctx, entry);
		else if (mask.kind === "text") paintTextElement(ctx, mask, element, lib);
		ctx.globalAlpha = 1;
		ctx.restore();
	}

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
						fill: emitted.fill,
						strokeWidth: emitted.strokeWidth,
						stroke: emitted.stroke,
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
