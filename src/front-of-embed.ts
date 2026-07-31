/**
 * Front-of-embed rendering -- deciding which elements need to appear in front of
 * an embeddable, and how each one is painted, working around Excalidraw always
 * painting embeddables above the canvas-drawn layer regardless of scene z-order.
 * See docs/behavior/front-of-embed-rendering.md and
 * docs/adr/0010-front-of-embed-rendering.md.
 *
 * The view layer paints those elements onto an overlay canvas. Almost every one
 * of them is drawn from the paths Excalidraw itself emitted, in the colours it
 * emitted them with (`emitted-geometry.ts`), which needs no shape knowledge at
 * all. The two exceptions are what `paintPlanFor` exists to name: text, which
 * Excalidraw exports as `<text>` rather than as path geometry, and images, whose
 * pixels can only be copied from Excalidraw's own canvas.
 *
 * Deliberately free of Obsidian/Excalidraw imports, like pack-elements.ts and
 * zorder.ts, so the rules can be reasoned about and unit-tested in isolation;
 * front-of-embed-view.ts does the API glue (compositing, font metrics, the blit).
 */

import { elementAABB, geometryOffset, type PackElement } from "./pack-elements";

/** The minimal element shape the front-of-embed planner and mask builder read. */
export interface FrontOfEmbedElement extends PackElement {
	/** Nested Excalidraw group ids; grouping changes nothing about how an element is drawn. */
	groupIds?: readonly string[];
	frameId?: string | null;
	/** Mirrors `containerId` on bound text: what tells a container it carries a label. */
	boundElements?: readonly { id: string; type: string }[] | null;
	/**
	 * What Excalidraw fills text glyphs with. Read only for text, the one type
	 * drawn rather than taken from its emitted paths -- every other type carries
	 * its colours in the paths themselves.
	 */
	strokeColor?: string;
	/** Excalidraw's 0-100 element opacity, applied live so changing it re-exports nothing. */
	opacity?: number;
	/** Set on an arrow Excalidraw routes as orthogonal segments rather than through its points. */
	elbowed?: boolean;
	/** Truthy for rounded corners between an arrow's points -- Excalidraw's default. See arrow-label-position.ts. */
	roundness?: unknown;
	/** Seeds rough.js's line/curve generation; read only when reconstructing a rounded arrow's drawn segment. */
	seed?: number;
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

const EPS = 1e-6;

function overlaps(a: FrontOfEmbedElement, b: FrontOfEmbedElement): boolean {
	const ra = elementAABB(a);
	const rb = elementAABB(b);
	return ra.minX < rb.maxX - EPS && ra.maxX > rb.minX + EPS && ra.minY < rb.maxY - EPS && ra.maxY > rb.minY + EPS;
}

/**
 * Whether an element can ever qualify for front-of-embed rendering, ignoring
 * z-order and overlap entirely. `container` is the element this one is bound to,
 * when it carries a `containerId` -- the caller resolves it, since eligibility
 * for a label depends on what it labels.
 *
 * Grouping is deliberately NOT a bail-out, unlike in
 * docs/behavior/overlap-aware-zorder.md. That feature *reorders* elements, which
 * is where Excalidraw's group z-order rules get non-trivial; this one only reads
 * the order that already exists. Excalidraw renders in array order and keeps a
 * group's members contiguous in that array, so "positioned after the embeddable"
 * means exactly what it does for a loose element, and grouping changes nothing
 * about how or where a member is drawn.
 *
 * Framed elements do still bail out: a frame clips its children, and the mask
 * has no clip of its own, so it would copy scene background from wherever the
 * frame cut the element off.
 *
 * Neither a *bound* nor an *elbowed* arrow bails out for being either. Both
 * used to be blanket excluded on the theory that their `points` aren't where
 * Excalidraw actually draws them -- true of the mask-and-blit approach this
 * mechanism used to use, verified live (2026-07-29) with an arrow bound
 * `mode: "inside"` to the very embeddable it crossed. But `points` is the
 * *only* place either a bound endpoint's pull-back (focus/gap/`fixedPoint`)
 * or an elbow-routed segment ever gets written to --
 * `packages/element/src/shape.ts` (both the canvas shape generator and
 * `exportToSvg` run through it) reads nothing but the element's own fields, no
 * binding lookups and no elbow-specific routing of its own -- and
 * `updateBoundElements`/`updateElbowArrowPoints` keep `points` in sync on
 * every drag/resize of the bound element or the arrow's own endpoints. So the
 * emitted path drawn since `c357f095` is exactly what's on screen for a bound
 * or elbowed arrow too; re-verified live (2026-07-31) against a real bound
 * arrow and a real bound *elbowed* arrow.
 *
 * A *labelled arrow* no longer bails out either. Its label's own `x`/`y` are
 * unreliable -- Excalidraw ignores them in favour of
 * `LinearElementEditor.getBoundTextElementPosition`, computed live from the
 * arrow's current `points` and only occasionally written back to the label's
 * stored `x`/`y` (unlike the arrow's own `points`, which get resynced on
 * every drag) -- so the view layer computes the label's real position itself
 * via `computeArrowLabelPosition` (`arrow-label-position.ts`) and paints the
 * label there instead of at its stored coordinates. A labelled *shape* never
 * needed this: `redrawTextBoundingBox` keeps its label's `x`/`y`/`angle` in
 * absolute scene terms already.
 */
export function isFrontOfEmbedEligible(
	element: FrontOfEmbedElement,
	container?: FrontOfEmbedElement | null,
): boolean {
	if (element.isDeleted) return false;
	if (NON_OCCLUDING_TYPES.has(element.type)) return false;
	if (element.frameId) return false;
	// A label whose container can't be resolved is a label that can't be placed.
	if (element.containerId && !container) return false;
	return true;
}

/**
 * Whether an element is an embeddable this mechanism treats as something to get
 * in front of. Exported for front-of-embed-layer.ts, which clips the read-only
 * front layer to exactly these -- the same set the candidates below were tested
 * against.
 */
export function isFrontOfEmbedEmbeddable(element: FrontOfEmbedElement): boolean {
	if (element.isDeleted) return false;
	if (!EMBEDDABLE_TYPES.has(element.type)) return false;
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
 * A bound label rides on its container's verdict rather than being tested on its
 * own, so a labelled shape or arrow and its label always cross the embeddable
 * together -- never the container in front with the words left behind. Its own
 * overlap test would
 * be the wrong question anyway: a label sitting clear of the embeddable inside a
 * container that crosses it still has to be masked, because the container's own
 * mask stops at its outline and does not carry the label with it.
 *
 * Deliberately does not distinguish *which* embeddable(s) an element is in front
 * of, or slice the overlay by depth -- a board with multiple embeddables at
 * interleaved depths is a documented known limitation. See "Known limitations"
 * in docs/behavior/front-of-embed-rendering.md.
 */
export function planFrontOfEmbedCandidates(
	allElements: readonly FrontOfEmbedElement[],
): readonly FrontOfEmbedElement[] {
	const byId = new Map<string, FrontOfEmbedElement>();
	for (const element of allElements) byId.set(element.id, element);

	// Pass 1: which unbound elements sit in front of an embeddable they overlap.
	const qualified = new Set<string>();
	const embeddablesSoFar: FrontOfEmbedElement[] = [];
	for (const element of allElements) {
		if (isFrontOfEmbedEmbeddable(element)) {
			embeddablesSoFar.push(element);
			continue;
		}
		// Labels are settled in pass 2; a container's own verdict is the answer for both.
		if (element.containerId) continue;
		if (!isFrontOfEmbedEligible(element)) continue;
		if (embeddablesSoFar.length === 0) continue;
		if (embeddablesSoFar.some((embeddable) => overlaps(element, embeddable))) qualified.add(element.id);
	}

	// Pass 2: back to scene order, folding in each qualifying container's label.
	// A separate pass rather than an inline lookup because nothing guarantees the
	// label follows its container in the array -- Excalidraw normalizes it that way,
	// but a candidate set that silently depended on that would be a trap.
	return allElements.filter((element) => {
		if (!element.containerId) return qualified.has(element.id);
		const container = byId.get(element.containerId);
		return qualified.has(element.containerId) && isFrontOfEmbedEligible(element, container);
	});
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
 * before blitting -- the ones affected by the placement quirk `elementPlacement`
 * compensates for. Mirrors its own `isLinearElement(element) ||
 * isFreeDrawElement(element)` guard in `generateElementCanvas`.
 */
const CANVAS_OFFSET_TYPES = new Set(["line", "arrow", "freedraw"]);

/** Where an element's paint sits inside its own box, in element-local units. */
export interface ElementPlacement {
	/** Excalidraw's own displacement of the drawn geometry -- 0 for everything unaffected. */
	shiftX: number;
	shiftY: number;
	/** The point Excalidraw rotates the element about. */
	pivotX: number;
	pivotY: number;
}

/**
 * How to place an element on the overlay so it lands on the pixels Excalidraw
 * actually drew, given the bounds Excalidraw itself computes for it. The overlay
 * has to agree with Excalidraw's *canvas* placement, not with the element's
 * nominal geometry: where a candidate crosses the embeddable's edge, the drawn
 * copy and Excalidraw's own copy have to meet without a jog.
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
 * exported geometry, so the overlay's copy straddled it -- the drawn stroke and
 * the canvas one visibly out of register at the embeddable's edge.
 */
export function elementPlacement(element: FrontOfEmbedElement, bounds: AbsoluteBounds | null): ElementPlacement {
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
 * How a candidate is painted. Almost every one is `"emitted"` -- drawn from the
 * paths Excalidraw exported for it, in the colours, widths and dash patterns
 * they came with, which needs no shape knowledge in this module at all. The
 * other two kinds are exactly the types that have no emitted path geometry:
 *
 * - `"text"`, which Excalidraw exports as `<text>`. Its glyphs are drawn in the
 *   element's own `strokeColor` at the placement described here, with the font
 *   metrics coming from Excalidraw in the view layer.
 * - `"image"`, whose pixels exist nowhere but Excalidraw's own canvas, so it is
 *   the one candidate still copied. Its mask is its whole opaque box, which is
 *   exactly its extent, so the copy brings no scene background with it.
 *
 * There is no reconstructed geometry and no fallback shape. An element whose
 * export has not landed yet is simply not painted this frame and stays behind
 * the embeddable until it has -- see docs/behavior/front-of-embed-rendering.md.
 */
export type PaintPlan =
	| { kind: "emitted" }
	| { kind: "image" }
	| {
			kind: "text";
			lines: readonly string[];
			lineHeightPx: number;
			/** Where the glyphs sit relative to the element's box, per `textAlign`. */
			horizontalOffset: number;
			textAlign: "left" | "center" | "right";
			fontSize: number;
			fontFamily: number;
	  };

/** Default Excalidraw text line height, used when an element predates the field. */
const DEFAULT_LINE_HEIGHT = 1.25;
const DEFAULT_FONT_SIZE = 20;
const DEFAULT_FONT_FAMILY = 5;

export function paintPlanFor(element: FrontOfEmbedElement): PaintPlan {
	if (element.type === "image") return { kind: "image" };
	if (element.type !== "text") return { kind: "emitted" };
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

