/**
 * PureRef-style "gravity pack" for selected Board elements — the Ctrl+Arrow
 * sort/snap. This module is deliberately free of Obsidian/Excalidraw imports so
 * the geometry can be reasoned about and unit-tested in isolation; the view
 * layer (excalidraw-view.ts) does the API glue.
 *
 * The rule, distilled from how PureRef behaves: every selected element travels
 * ONLY along the arrow axis until its leading edge meets either the global
 * boundary (the leading-most edge among the whole selection — "the lowest point
 * of the lowest element" for Ctrl+Down) or the near edge of an element it
 * overlaps on the *perpendicular* axis, in which case it stacks with a small
 * gap. Perpendicular position is never touched — so a selection spread out
 * across the axis settles into a neat line, while one stacked up on the axis
 * piles into a column. Same rule, both outcomes. Elements are never resized or
 * rotated.
 */

export type PackDirection = "up" | "down" | "left" | "right";

/** The minimal element shape the packer reads. Matches Excalidraw's elements. */
export interface PackElement {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Rotation in radians, about the element's center. */
	angle?: number;
	/** Set on text bound to a container; such text must follow its owner. */
	containerId?: string | null;
	isDeleted?: boolean;
}

/** A per-element translation the caller applies to `x`/`y`. */
export interface PackMove {
	id: string;
	dx: number;
	dy: number;
}

/** Axis-aligned bounding box in scene coordinates. */
interface Rect {
	id: string;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Element types that are NOT reference-like and so are excluded from packing:
 * freehand drawings, connectors, and geometric shapes (per the requirement to
 * "exclude drawing, shapes, and arrows"), plus frames and the selection marquee.
 * Everything else — images, embeddable/iframe media, and standalone text — packs.
 */
const NON_PACKABLE_TYPES = new Set([
	"freedraw",
	"line",
	"arrow",
	"rectangle",
	"ellipse",
	"diamond",
	"frame",
	"magicframe",
	"selection",
]);

/** Whether an element participates in a pack (reference-like and free-standing). */
export function isPackable(el: PackElement): boolean {
	if (el.isDeleted) return false;
	if (NON_PACKABLE_TYPES.has(el.type)) return false;
	// Text bound to a container moves with that container, not on its own.
	if (el.containerId) return false;
	return true;
}

/**
 * The axis-aligned bounding box of a (possibly rotated) element. Excalidraw
 * stores x/y/width/height for the *unrotated* box and rotates about the center,
 * so the visible extent of a rotated element is wider; packing against the true
 * visual box keeps rotated references from overlapping. Translating x/y shifts
 * this box rigidly, so a delta computed here applies directly to x/y.
 */
function elementAABB(el: PackElement): Rect {
	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const a = el.angle ?? 0;
	const cos = Math.abs(Math.cos(a));
	const sin = Math.abs(Math.sin(a));
	const hw = (cos * el.width + sin * el.height) / 2;
	const hh = (sin * el.width + cos * el.height) / 2;
	return { id: el.id, minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
}

/**
 * Computes the gravity-pack translations for a set of already-filtered,
 * packable elements. Returns only the elements that actually move. A pack needs
 * at least two elements (a single one has nothing to settle against), matching
 * PureRef where Ctrl+Arrow on one element is a no-op.
 */
export function planPack(elements: PackElement[], direction: PackDirection, gap: number): PackMove[] {
	if (elements.length < 2) return [];

	const vertical = direction === "up" || direction === "down";
	// +1 travels toward increasing coordinate (down / right), -1 toward decreasing.
	const dir = direction === "down" || direction === "right" ? 1 : -1;

	// Motion-axis accessors (lo = top/left edge, hi = bottom/right edge).
	const lo = (r: Rect) => (vertical ? r.minY : r.minX);
	const hi = (r: Rect) => (vertical ? r.maxY : r.maxX);
	// Leading edge in the direction of travel.
	const leading = (r: Rect) => (dir > 0 ? hi(r) : lo(r));
	// Perpendicular-axis span, used to decide whether two elements collide.
	const perpLo = (r: Rect) => (vertical ? r.minX : r.minY);
	const perpHi = (r: Rect) => (vertical ? r.maxX : r.maxY);

	const rects = elements.map(elementAABB);

	// The wall everything falls toward: the leading-most edge in the selection.
	const boundary = dir > 0 ? Math.max(...rects.map(hi)) : Math.min(...rects.map(lo));

	// Settle nearest-the-boundary first, so a piece never claims space a lower
	// piece still needs.
	const order = [...rects].sort((a, b) => dir * (leading(b) - leading(a)));

	const EPS = 1e-6;
	const overlapsPerp = (a: Rect, b: Rect) =>
		perpLo(a) < perpHi(b) - EPS && perpHi(a) > perpLo(b) + EPS;

	const placed: Rect[] = [];
	const moves: PackMove[] = [];

	for (const r of order) {
		// Fall to the boundary, unless a placed element blocks the way sooner.
		let restLeading = boundary;
		for (const p of placed) {
			if (!overlapsPerp(r, p)) continue;
			// The blocker's facing edge, backed off by the gap. dir>0: rest on its
			// top (p.lo - gap); dir<0: rest under its bottom (p.hi + gap).
			const surface = (dir > 0 ? lo(p) : hi(p)) - dir * gap;
			restLeading = dir > 0 ? Math.min(restLeading, surface) : Math.max(restLeading, surface);
		}

		const delta = restLeading - leading(r);
		// Shift this rect (motion axis only) and record it as an obstacle.
		if (vertical) {
			r.minY += delta;
			r.maxY += delta;
		} else {
			r.minX += delta;
			r.maxX += delta;
		}
		placed.push(r);

		if (Math.abs(delta) > EPS) {
			moves.push({ id: r.id, dx: vertical ? 0 : delta, dy: vertical ? delta : 0 });
		}
	}

	return moves;
}
