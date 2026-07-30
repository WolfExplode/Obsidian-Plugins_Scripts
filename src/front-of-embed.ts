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

import { elementAABB, type PackElement } from "./pack-elements";

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
	/** Linear elements (line/arrow/freedraw): vertices relative to `x`/`y`. */
	points?: readonly (readonly number[])[];
	/** Non-null when Excalidraw draws the element curved rather than as straight segments. */
	roundness?: { type: number } | null;
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
 * Scene-space slack for rough.js's hand-drawn jitter, which overshoots the
 * mathematical path an element nominally follows by a unit or two. Scene-space
 * because the jitter is part of the drawing, so it scales with the element.
 */
export const MASK_JITTER_ALLOWANCE = 2;

/**
 * Screen-space slack for the antialiased edge of whatever was rendered. Screen
 * space because antialiasing is always about a pixel wide no matter the zoom --
 * folding it into the scene-space allowance instead put a visible halo of scene
 * background around zoomed-in text, since a fixed scene-space rim grows on
 * screen as you zoom in.
 */
export const MASK_ANTIALIAS_ALLOWANCE_PX = 1.5;

/**
 * How far to grow a mask beyond the element's exact geometry, in scene units at
 * the given zoom. Growing it bleeds a thin rim of scene background over the
 * embeddable; not growing it clips a hairline off the element's own edge, which
 * is the more visible of the two. `roughStroke` is false for text, which
 * Excalidraw renders as ordinary glyphs with no jitter to accommodate.
 */
export function maskDilation(zoom: number, roughStroke: boolean): number {
	const antialias = MASK_ANTIALIAS_ALLOWANCE_PX / Math.max(zoom, 1e-6);
	return roughStroke ? MASK_JITTER_ALLOWANCE + antialias : antialias;
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
	| { kind: "ellipse"; fill: boolean; strokeWidth: number }
	| {
			kind: "path";
			points: readonly (readonly number[])[];
			closed: boolean;
			fill: boolean;
			strokeWidth: number;
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

export function maskShapeFor(element: FrontOfEmbedElement): MaskShape {
	const strokeWidth = element.strokeWidth ?? 1;
	const fill = !!element.backgroundColor && element.backgroundColor !== "transparent";

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

	if (element.points && element.points.length > 1) {
		// Never closed: a freedraw stroke's last point is wherever the pen lifted, so
		// closing the path drew a chord straight back to where it started -- which
		// masked a black band of background right across the embeddable (seen live,
		// 2026-07-29). A `fill` still closes implicitly, which is what a filled
		// closed loop needs anyway.
		return {
			kind: "path",
			points: element.points,
			closed: false,
			fill,
			strokeWidth,
			// freedraw points are already dense enough to trace the drawn stroke.
			smooth: !!element.roundness && element.type !== "freedraw",
		};
	}

	if (element.type === "ellipse") return { kind: "ellipse", fill, strokeWidth };

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
			smooth: false,
		};
	}

	if (element.type === "rectangle") {
		const { width: w, height: h } = element;
		return {
			kind: "path",
			points: [
				[0, 0],
				[w, 0],
				[w, h],
				[0, h],
			],
			closed: true,
			fill,
			strokeWidth,
			smooth: false,
		};
	}

	// image, and any element type this plugin hasn't accounted for: mask the whole
	// box. Over-masking bleeds background; under-masking would drop the element.
	return { kind: "box" };
}
