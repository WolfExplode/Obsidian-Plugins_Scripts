/**
 * Front-of-embed rendering -- deciding which elements need to appear in front of
 * an embeddable, and what shape to mask each one with, working around Excalidraw
 * always painting embeddables above the canvas-drawn layer regardless of scene
 * z-order. See docs/behavior/front-of-embed-rendering.md and
 * docs/adr/0010-front-of-embed-rendering.md.
 *
 * The mechanism does NOT re-render those elements: Excalidraw has already
 * rendered them, this frame, into its own static canvas, so the view layer
 * copies that canvas through an alpha mask built from the shapes described here.
 * That makes this module's job purely geometric -- eligibility plus "what region
 * does this element occlude" -- with no rendering fidelity to reproduce.
 *
 * Deliberately free of Obsidian/Excalidraw imports, like pack-elements.ts and
 * zorder.ts, so the rules can be reasoned about and unit-tested in isolation;
 * front-of-embed-view.ts does the API glue (mask painting, canvas blit).
 */

import { freehandInputPoints, freehandOptionsFor, getStroke, type FreehandStrokeOptions } from "./freehand";
import { elementAABB, geometryOffset, type PackElement } from "./pack-elements";
import { roughCurve, roughLinearPath, roughOptionsFor, roughRectangle, roughRoundRect, type RoughOp } from "./rough";

/** The minimal element shape the front-of-embed planner and mask builder read. */
export interface FrontOfEmbedElement extends PackElement {
	/** Nested Excalidraw group ids; a non-empty list means this element bails out. */
	groupIds?: readonly string[];
	frameId?: string | null;
	/** Mirrors `containerId` on bound text: a labelled container bails out too. */
	boundElements?: readonly { id: string; type: string }[] | null;
	strokeWidth?: number;
	/** `"transparent"` (or absent) means the element's interior occludes nothing. */
	backgroundColor?: string;
	/** rough.js hand-drawn jitter: 0 (architect) draws exactly on the path, 2 (cartoonist) wanders furthest. */
	roughness?: number;
	/** `"solid"` (or absent), `"dashed"`, or `"dotted"` -- a dashed stroke leaves gaps a solid mask would cover. */
	strokeStyle?: string;
	/** Seeds rough.js's generator, which is what makes the hand-drawn jitter reproducible. */
	seed?: number;
	/** Linear elements (line/arrow/freedraw): vertices relative to `x`/`y`. */
	points?: readonly (readonly number[])[];
	/** Freedraw: recorded pen pressure per point, when the input device reported any. */
	pressures?: readonly number[];
	/** Freedraw: false when pressure was recorded rather than derived from speed. */
	simulatePressure?: boolean;
	/** Freedraw: set once the stroke is committed, which pins its final point. */
	lastCommittedPoint?: unknown;
	/** Freedraw: the element's own record of the pen it was drawn with -- see `FreehandStrokeOptions`. */
	strokeOptions?: FreehandStrokeOptions | null;
	/**
	 * Non-null when Excalidraw draws the element curved rather than as straight
	 * segments. On a rectangle it instead means rounded corners, and `value` is the
	 * adaptive radius when the element carries an explicit one.
	 */
	roundness?: { type: number; value?: number } | null;
	/** Set on an arrow whose endpoint is attached to another element, which moves where it's drawn. */
	startBinding?: unknown;
	endBinding?: unknown;
	/** Set on an arrow Excalidraw routes as orthogonal segments rather than through its points. */
	elbowed?: boolean;
	text?: string;
	fontSize?: number;
	fontFamily?: number;
	lineHeight?: number;
	textAlign?: string;
}

/**
 * Element types that never occlude an embeddable through this mechanism.
 * `embeddable`/`iframe` already respect z-order against each other natively;
 * frames and the selection marquee are chrome, not content.
 */
const NON_OCCLUDING_TYPES = new Set(["embeddable", "iframe", "frame", "magicframe", "selection"]);

/** Types treated as an embeddable for z-order purposes -- what an element can be "in front of". */
const EMBEDDABLE_TYPES = new Set(["embeddable", "iframe"]);

/**
 * Scene-space slack for rough.js's hand-drawn jitter, per unit of the element's
 * `roughness`. Scene-space because the jitter is part of the drawing, so it
 * scales with the element. Scaled by roughness because that is what rough.js
 * multiplies its own offsets by: an architect-style (roughness 0) element is
 * drawn exactly on its path and needs no allowance at all, where the flat
 * allowance this replaces put two units of scene background around it.
 */
export const MASK_JITTER_ALLOWANCE = 2;

/**
 * Screen-space slack for the antialiased edge of whatever was rendered. Screen
 * space because antialiasing is always about a pixel wide no matter the zoom --
 * folding it into the scene-space allowance instead put a visible halo of scene
 * background around zoomed-in text, since a fixed scene-space rim grows on
 * screen as you zoom in.
 *
 * Half a pixel, not the 1.5 this started at: an antialiased edge spans about a
 * pixel in total, and since the source canvas is opaque every tenth of a pixel
 * of overshoot is scene background painted onto the embeddable, not a soft edge.
 */
export const MASK_ANTIALIAS_ALLOWANCE_PX = 0.5;

/**
 * Excalidraw's freedraw stroke is not `strokeWidth` wide. It hands
 * perfect-freehand `size: strokeWidth * 4.25` and fills the variable-width
 * outline that comes back, tapering with pressure. Masking the nominal
 * `strokeWidth` therefore covered a quarter of the drawn stroke and relied on
 * the dilation to cover the rest, which only worked at one stroke width: at
 * `strokeWidth` 4 the mask clipped the stroke, and at 1 it bled background.
 *
 * Confirmed live (2026-07-30) by measuring perpendicular ink runs across a
 * `strokeWidth` 2 freedraw: median 7.26 scene units, 90th percentile 8.9,
 * against the 8.5 this factor predicts as the full-pressure maximum.
 */
export const FREEDRAW_SIZE_FACTOR = 4.25;

/** Excalidraw's default `roughness` (artist), for elements that predate the field. */
const DEFAULT_ROUGHNESS = 1;

/**
 * Excalidraw's dash patterns, in scene units, mirroring its own
 * `getDashArrayDashed` / `getDashArrayDotted`. A dashed stroke leaves real gaps,
 * and a solid mask over one paints scene background into every gap.
 *
 * Verified live (2026-07-30) against `exportToSvg` on a `strokeWidth` 2
 * rectangle: `stroke-dasharray="8 10"` when dashed and `"1.5 8"` when dotted.
 */
export function dashArrayFor(strokeStyle: string | undefined, strokeWidth: number): readonly number[] | null {
	if (strokeStyle === "dashed") return [8, 8 + strokeWidth];
	if (strokeStyle === "dotted") return [1.5, 6 + strokeWidth];
	return null;
}

/**
 * The width Excalidraw hands rough.js. A non-solid stroke is drawn half a unit
 * wider -- and as a single pass rather than rough's usual two, which is why it
 * needs the extra width to read as solidly. Same source as `dashArrayFor`: the
 * exported `stroke-width` is 2.5 for a `strokeWidth` 2 dashed or dotted stroke,
 * and 2 when solid.
 */
export function drawnStrokeWidth(strokeStyle: string | undefined, strokeWidth: number): number {
	return strokeStyle && strokeStyle !== "solid" ? strokeWidth + 0.5 : strokeWidth;
}

/**
 * How far to grow a mask beyond the element's exact geometry, in scene units at
 * the given zoom. Growing it bleeds a rim of scene background over the
 * embeddable; not growing it clips a hairline off the element's own edge.
 * `roughness` is 0 for anything Excalidraw draws deterministically -- text
 * glyphs and freedraw strokes -- and the element's own rough.js roughness
 * otherwise.
 */
export function maskDilation(zoom: number, roughness: number): number {
	const antialias = MASK_ANTIALIAS_ALLOWANCE_PX / Math.max(zoom, 1e-6);
	return MASK_JITTER_ALLOWANCE * Math.max(0, roughness) + antialias;
}

/**
 * The cubic Bézier segments rough.js draws a curved linear element as, matching
 * its `_curve`/`_curveWithOffset` pair: a Catmull-Rom spline through the points
 * with the first and last duplicated, at the default `curveTightness` of 0.
 *
 * The quadratic-through-midpoints smoothing this replaces was not an
 * approximation of that curve so much as a different curve -- on a three-point
 * arrow its midpoint sat 210 scene units away from where rough.js actually drew,
 * so the mask tracked nothing and painted a band of background along a path the
 * stroke never took.
 */
export function curveControlPoints(
	points: readonly (readonly number[])[],
): ReadonlyArray<{ cp1: readonly [number, number]; cp2: readonly [number, number]; to: readonly [number, number] }> {
	const at = (index: number): readonly [number, number] => {
		const point = points[Math.min(Math.max(index, 0), points.length - 1)];
		return [point?.[0] ?? 0, point?.[1] ?? 0];
	};
	const segments = [];
	for (let i = 0; i < points.length - 1; i++) {
		// Duplicated endpoints fall out of the clamping in `at`, which is what makes
		// the spline pass through the first and last point instead of starting short.
		const previous = at(i - 1);
		const from = at(i);
		const to = at(i + 1);
		const next = at(i + 2);
		segments.push({
			cp1: [from[0] + (to[0] - previous[0]) / 6, from[1] + (to[1] - previous[1]) / 6] as const,
			cp2: [to[0] + (from[0] - next[0]) / 6, to[1] + (from[1] - next[1]) / 6] as const,
			to,
		});
	}
	return segments;
}

const EPS = 1e-6;

function overlaps(a: FrontOfEmbedElement, b: FrontOfEmbedElement): boolean {
	const ra = elementAABB(a);
	const rb = elementAABB(b);
	return ra.minX < rb.maxX - EPS && ra.maxX > rb.minX + EPS && ra.minY < rb.maxY - EPS && ra.maxY > rb.minY + EPS;
}

/**
 * Whether an element can ever qualify for front-of-embed rendering, ignoring
 * z-order and overlap entirely. Grouped and framed elements are excluded
 * outright -- see the "Deliberate scope cut" in
 * docs/behavior/overlap-aware-zorder.md for the same reasoning: Excalidraw's
 * group/frame z-order semantics are non-trivial and out of proportion to the
 * value of reimplementing them here. A container and its bound text bail out as
 * a pair, so a labelled shape never renders in front of an embeddable with its
 * label left behind it.
 *
 * Bound and elbowed arrows bail out for the same reason, one step further along:
 * their `points` are not where Excalidraw actually draws them. A bound endpoint
 * is pulled back to the bound element's boundary (focus, gap, and `fixedPoint`
 * all feed into where), and an elbowed arrow is re-routed as orthogonal segments
 * entirely. Masking the points instead of the drawn path painted a thick band of
 * scene background along the segment where the stroke wasn't -- verified live
 * (2026-07-29) with an arrow bound `mode: "inside"` to the very embeddable it
 * crossed.
 */
export function isFrontOfEmbedEligible(element: FrontOfEmbedElement): boolean {
	if (element.isDeleted) return false;
	if (NON_OCCLUDING_TYPES.has(element.type)) return false;
	if (element.groupIds && element.groupIds.length > 0) return false;
	if (element.frameId) return false;
	if (element.containerId) return false;
	if (element.boundElements?.some((bound) => bound.type === "text")) return false;
	if (element.startBinding || element.endBinding) return false;
	if (element.elbowed) return false;
	return true;
}

function isEligibleEmbeddable(element: FrontOfEmbedElement): boolean {
	if (element.isDeleted) return false;
	if (!EMBEDDABLE_TYPES.has(element.type)) return false;
	if (element.groupIds && element.groupIds.length > 0) return false;
	if (element.frameId) return false;
	return true;
}

/**
 * Every eligible element that overlaps at least one eligible embeddable
 * positioned earlier in the scene array (i.e. behind it, per Bring to Front /
 * Send to Back semantics), in scene order. This is the set whose pixels must be
 * copied over the embeddable layer; everything else is already correct in
 * Excalidraw's own canvas.
 *
 * Deliberately does not distinguish *which* embeddable(s) an element is in front
 * of, or slice the overlay by depth -- a board with multiple embeddables at
 * interleaved depths is a documented known limitation. See "Known limitations"
 * in docs/behavior/front-of-embed-rendering.md.
 */
export function planFrontOfEmbedCandidates(
	allElements: readonly FrontOfEmbedElement[],
): readonly FrontOfEmbedElement[] {
	const candidates: FrontOfEmbedElement[] = [];
	const embeddablesSoFar: FrontOfEmbedElement[] = [];

	for (const element of allElements) {
		if (isEligibleEmbeddable(element)) {
			embeddablesSoFar.push(element);
			continue;
		}
		if (!isFrontOfEmbedEligible(element)) continue;
		if (embeddablesSoFar.length === 0) continue;
		if (embeddablesSoFar.some((embeddable) => overlaps(element, embeddable))) candidates.push(element);
	}

	return candidates;
}

/**
 * An element's unrotated bounds in scene coordinates, as Excalidraw's own
 * `getElementAbsoluteCoords` reports them -- for a linear element these are the
 * bounds of the *drawn curve*, hand-drawn jitter included, which is why they
 * don't line up with `x`/`y` plus `width`/`height`.
 */
export interface AbsoluteBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Element types Excalidraw renders through a per-element canvas that it offsets
 * before blitting -- the ones affected by the placement quirk `maskPlacement`
 * compensates for. Mirrors its own `isLinearElement(element) ||
 * isFreeDrawElement(element)` guard in `generateElementCanvas`.
 */
const CANVAS_OFFSET_TYPES = new Set(["line", "arrow", "freedraw"]);

/** Where an element's mask sits inside its own box, in element-local units. */
export interface MaskPlacement {
	/** Excalidraw's own displacement of the drawn geometry -- 0 for everything unaffected. */
	shiftX: number;
	shiftY: number;
	/** The point Excalidraw rotates the element about. */
	pivotX: number;
	pivotY: number;
}

/**
 * How to place an element's mask so it lands on the pixels Excalidraw actually
 * drew, given the bounds Excalidraw itself computes for it.
 *
 * The rotation pivot is the centre of those bounds, which is what
 * `drawElementFromCanvas` rotates about -- for a linear element that is *not*
 * the centre of `x`/`y`/`width`/`height`.
 *
 * The shift compensates for a placement quirk in Excalidraw's own renderer.
 * `generateElementCanvas` positions a linear or freedraw element's canvas with
 *
 *     canvasOffsetY = element.y > y1 ? distance(element.y, y1) * ... : 0
 *
 * while `drawElementFromCanvas` blits that canvas as though its content started
 * at `y1`. The two agree whenever the drawn geometry reaches up and left past
 * the element's origin, which is the usual case -- but when it starts *after*
 * the origin (`element.y < y1`) the guard clamps the offset to 0 and the element
 * is painted `y1 - element.y` too low. Same on x.
 *
 * That mostly happens with a cartoonist-roughness dashed or dotted stroke: those
 * are drawn as a single rough.js pass with unpinned vertices, so the whole curve
 * can sit below where its first point is recorded. Measured live (2026-07-30) on
 * a dashed cartoonist curve: Excalidraw drew it 1.41 scene units below its own
 * exported geometry, which the mask then straddled -- background copied along the
 * top of every dash and the bottom of the stroke left behind.
 */
export function maskPlacement(element: FrontOfEmbedElement, bounds: AbsoluteBounds | null): MaskPlacement {
	if (!bounds) {
		// Excalidraw's bounds are the only source for this; without them, fall back to
		// the points' own box, which is the same thing to within the jitter.
		const [offsetX, offsetY] = geometryOffset(element);
		return {
			shiftX: 0,
			shiftY: 0,
			pivotX: offsetX + element.width / 2,
			pivotY: offsetY + element.height / 2,
		};
	}
	const offset = CANVAS_OFFSET_TYPES.has(element.type);
	return {
		shiftX: offset ? Math.max(0, bounds.minX - element.x) : 0,
		shiftY: offset ? Math.max(0, bounds.minY - element.y) : 0,
		pivotX: (bounds.minX + bounds.maxX) / 2 - element.x,
		pivotY: (bounds.minY + bounds.maxY) / 2 - element.y,
	};
}

/**
 * The region an element occludes, in element-local coordinates (origin at the
 * element's unrotated top-left, before zoom and rotation, which the view layer
 * applies as a transform).
 *
 * Outlined shapes are stroked at `strokeWidth` plus the mask dilation, and
 * filled only when the element actually has a fill: masking an unfilled
 * rectangle's interior would paint a slab of scene background over the
 * embeddable inside it, instead of letting the embeddable show through as it
 * does everywhere else on the canvas.
 */
export type MaskShape =
	/** Occludes its whole bounding box -- images and anything else opaque by nature. */
	| { kind: "box" }
	| { kind: "ellipse"; fill: boolean; strokeWidth: number; roughness: number; dash: readonly number[] | null }
	/**
	 * A rectangle, whose corners Excalidraw rounds by default. `radius` is 0 for a
	 * sharp-cornered one; masking a rounded rectangle with square corners left four
	 * triangles of scene background outside the drawn corner arcs (seen live,
	 * 2026-07-30).
	 */
	/**
	 * The hand-drawn path rough.js actually drew, reconstructed from the element's
	 * `seed`. Needs no jitter allowance at all, because it *is* the jitter -- see
	 * rough.ts. `fillPoints` is the nominal outline, used only to cover a filled
	 * interior; the drawn edge comes from `ops`.
	 */
	| {
			kind: "rough";
			ops: readonly RoughOp[];
			fillPoints: readonly (readonly number[])[] | null;
			/**
			 * Fills the element's whole box with this corner radius instead of
			 * `fillPoints` -- a rounded rectangle's interior, which no polygon expresses.
			 * 0 means "use `fillPoints`". Only ever one or the other.
			 */
			fillRadius: number;
			strokeWidth: number;
			dash: readonly number[] | null;
	  }
	/**
	 * A freedraw, masked by the closed polygon perfect-freehand builds around the
	 * stroke -- the same geometry Excalidraw fills. Not a stroked centerline: the
	 * points are streamlined before they are drawn, so the recorded points aren't
	 * where the stroke is, and its width varies with pressure along its length.
	 */
	| {
			kind: "outline";
			points: readonly (readonly number[])[];
			/** The raw points, when the stroke loops and carries a background Excalidraw fills too. */
			interior: readonly (readonly number[])[] | null;
	  }
	| {
			kind: "path";
			points: readonly (readonly number[])[];
			closed: boolean;
			fill: boolean;
			/** The width Excalidraw *draws* the stroke at, which for freedraw is not `element.strokeWidth`. */
			strokeWidth: number;
			/** 0 where Excalidraw draws deterministically, so no jitter allowance is added. */
			roughness: number;
			/** Excalidraw's dash pattern in scene units, or null for a solid stroke. */
			dash: readonly number[] | null;
			/**
			 * Whether the points are a curve's control points rather than the drawn
			 * path itself. A curved arrow bows away from the straight chord between
			 * its points by far more than the dilation covers, so masking the chord
			 * both clipped the real curve and painted a black ribbon of background
			 * along the chord (seen live, 2026-07-29).
			 */
			smooth: boolean;
	  }
	/**
	 * Glyph-accurate text mask. The view layer resolves the font string and the
	 * alphabetic-baseline offset (both need font metrics only Excalidraw has) and
	 * paints the same lines at the same offsets Excalidraw's own text renderer
	 * uses, so the mask hugs the glyphs instead of the text box.
	 */
	| {
			kind: "text";
			lines: readonly string[];
			lineHeightPx: number;
			horizontalOffset: number;
			textAlign: "left" | "center" | "right";
			fontSize: number;
			fontFamily: number;
	  };

/** Default Excalidraw text line height, used when an element predates the field. */
const DEFAULT_LINE_HEIGHT = 1.25;
const DEFAULT_FONT_SIZE = 20;
const DEFAULT_FONT_FAMILY = 5;

/**
 * Excalidraw's `LINE_CONFIRM_THRESHOLD` -- how close a linear element's last
 * point has to come back to its first for the path to count as closed.
 */
const LINE_CONFIRM_THRESHOLD = 10;

/**
 * Whether Excalidraw treats a linear element's path as a closed loop, mirroring
 * its own `isPathALoop`. This is the only condition under which it fills a
 * freedraw, line, or arrow at all: an open stroke is drawn as a bare stroke no
 * matter what background colour is set on it, so its background must not become
 * part of the mask. Verified live (2026-07-30): open `line` elements carrying a
 * `#e78190` background render unfilled, while the ones whose endpoints coincide
 * render filled.
 */
function isPathALoop(points: readonly (readonly number[])[]): boolean {
	if (points.length < 3) return false;
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) return false;
	return Math.hypot((last[0] ?? 0) - (first[0] ?? 0), (last[1] ?? 0) - (first[1] ?? 0)) <= LINE_CONFIRM_THRESHOLD;
}

/** Excalidraw's `ROUNDNESS` enum (verified live against `window.ExcalidrawLib.ROUNDNESS`). */
const ROUNDNESS_LEGACY = 1;
const ROUNDNESS_PROPORTIONAL_RADIUS = 2;
const ROUNDNESS_ADAPTIVE_RADIUS = 3;

/** Excalidraw's own corner-radius constants (packages/element/src/shapes.ts). */
const PROPORTIONAL_RADIUS_RATIO = 0.25;
const DEFAULT_ADAPTIVE_RADIUS = 32;

/**
 * The corner radius Excalidraw draws a rectangle with, mirroring its own
 * `getCornerRadius`. A proportional radius is a flat quarter of the shorter side;
 * an adaptive one is that same quarter until the shape is big enough for the
 * fixed radius to be the smaller of the two, and the fixed radius thereafter.
 */
function cornerRadius(element: FrontOfEmbedElement): number {
	const roundness = element.roundness;
	if (!roundness) return 0;
	const shorterSide = Math.min(Math.abs(element.width), Math.abs(element.height));
	if (roundness.type === ROUNDNESS_LEGACY || roundness.type === ROUNDNESS_PROPORTIONAL_RADIUS) {
		return shorterSide * PROPORTIONAL_RADIUS_RATIO;
	}
	if (roundness.type === ROUNDNESS_ADAPTIVE_RADIUS) {
		const fixedRadius = roundness.value ?? DEFAULT_ADAPTIVE_RADIUS;
		const cutoff = fixedRadius / PROPORTIONAL_RADIUS_RATIO;
		return shorterSide <= cutoff ? shorterSide * PROPORTIONAL_RADIUS_RATIO : fixedRadius;
	}
	return 0;
}

/**
 * A diamond's four vertices, mirroring Excalidraw's own `getDiamondPoints`. The
 * top and right are `floor(side / 2) + 1`, not the midpoint -- a unit off, but
 * enough that a mask built on the midpoint misses the drawn path (verified live,
 * 2026-07-30: a 280x200 diamond is drawn through x=141, y=101).
 */
function diamondPoints(element: FrontOfEmbedElement): readonly (readonly number[])[] {
	const midX = Math.floor(element.width / 2) + 1;
	const midY = Math.floor(element.height / 2) + 1;
	return [
		[midX, 0],
		[element.width, midY],
		[midX, element.height],
		[0, midY],
	];
}

export function maskShapeFor(element: FrontOfEmbedElement): MaskShape {
	const nominalStrokeWidth = element.strokeWidth ?? 1;
	const strokeWidth = drawnStrokeWidth(element.strokeStyle, nominalStrokeWidth);
	const dash = dashArrayFor(element.strokeStyle, nominalStrokeWidth);
	const fill = !!element.backgroundColor && element.backgroundColor !== "transparent";
	const roughness = element.roughness ?? DEFAULT_ROUGHNESS;

	if (element.type === "text") {
		const fontSize = element.fontSize ?? DEFAULT_FONT_SIZE;
		const textAlign = element.textAlign === "center" || element.textAlign === "right" ? element.textAlign : "left";
		return {
			kind: "text",
			lines: (element.text ?? "").replace(/\r\n?/g, "\n").split("\n"),
			lineHeightPx: (element.lineHeight ?? DEFAULT_LINE_HEIGHT) * fontSize,
			// Matches Excalidraw's own horizontalOffset for the same textAlign.
			horizontalOffset: textAlign === "center" ? element.width / 2 : textAlign === "right" ? element.width : 0,
			textAlign,
			fontSize,
			fontFamily: element.fontFamily ?? DEFAULT_FONT_FAMILY,
		};
	}

	if (element.type === "freedraw" && element.points && element.points.length > 0) {
		const outline = getStroke(freehandInputPoints(element), freehandOptionsFor(element));
		if (outline.length > 3) {
			return {
				kind: "outline",
				points: outline,
				interior: fill && isPathALoop(element.points) ? element.points : null,
			};
		}
	}

	// Everything rough.js draws along a path this port can reproduce exactly, from
	// the element's own seed -- so these need no jitter allowance at all. Ellipses
	// are not here yet: Excalidraw draws those through rough's own ellipse routine.
	if (element.points && element.points.length > 1 && (element.type === "line" || element.type === "arrow")) {
		const points = element.points;
		const options = roughOptionsFor(element, !element.roundness);
		return {
			kind: "rough",
			ops: element.roundness ? roughCurve(points, options) : roughLinearPath(points, false, options),
			fillPoints: fill && isPathALoop(points) ? points : null,
			fillRadius: 0,
			strokeWidth,
			dash,
		};
	}

	if (element.type === "rectangle") {
		const { width: w, height: h } = element;
		const radius = cornerRadius(element);
		const options = roughOptionsFor(element, true);
		return {
			kind: "rough",
			ops: radius > 0 ? roughRoundRect(w, h, radius, options) : roughRectangle(w, h, options),
			fillPoints: fill && radius === 0 ? [[0, 0], [w, 0], [w, h], [0, h]] : null,
			fillRadius: fill ? radius : 0,
			strokeWidth,
			dash,
		};
	}

	if (element.type === "diamond" && !element.roundness) {
		const points = diamondPoints(element);
		return {
			kind: "rough",
			ops: roughLinearPath(points, true, roughOptionsFor(element, true)),
			fillPoints: fill ? points : null,
			fillRadius: 0,
			strokeWidth,
			dash,
		};
	}

	if (element.points && element.points.length > 1) {
		const isFreedraw = element.type === "freedraw";
		// Never closed: a freedraw stroke's last point is wherever the pen lifted, so
		// closing the path drew a chord straight back to where it started -- which
		// masked a black band of background right across the embeddable (seen live,
		// 2026-07-29). A `fill` still closes implicitly, which is what a filled
		// closed loop needs anyway.
		return {
			kind: "path",
			points: element.points,
			closed: false,
			// A linear element is only filled when its path closes back on itself --
			// see `isPathALoop`. An open stroke with a background colour set is drawn
			// as a bare stroke, so filling its raw polyline masks the whole convex
			// sweep of the path: a solid band of scene background clear across the
			// embeddable (seen live, 2026-07-30, on both a 636-point freedraw scribble
			// and an open line).
			fill: fill && isPathALoop(element.points),
			// perfect-freehand draws a freedraw far wider than its nominal strokeWidth.
			strokeWidth: isFreedraw ? strokeWidth * FREEDRAW_SIZE_FACTOR : strokeWidth,
			// A freedraw goes through perfect-freehand, not rough.js, so there is no
			// hand-drawn jitter to leave room for -- the stroke lands exactly on its
			// points. The flat allowance this replaces was two units of pure scene
			// background on both sides of every freedraw, growing on screen with zoom,
			// which is what made a zoomed-in stroke look edged and jagged.
			roughness: isFreedraw ? 0 : roughness,
			dash,
			// freedraw points are already dense enough to trace the drawn stroke.
			smooth: !!element.roundness && !isFreedraw,
		};
	}

	if (element.type === "ellipse") return { kind: "ellipse", fill, strokeWidth, roughness, dash };

	if (element.type === "diamond") {
		const { width: w, height: h } = element;
		return {
			kind: "path",
			points: [
				[w / 2, 0],
				[w, h / 2],
				[w / 2, h],
				[0, h / 2],
			],
			closed: true,
			fill,
			strokeWidth,
			roughness,
			dash,
			smooth: false,
		};
	}

	// image, and any element type this plugin hasn't accounted for: mask the whole
	// box. Over-masking bleeds background; under-masking would drop the element.
	return { kind: "box" };
}
