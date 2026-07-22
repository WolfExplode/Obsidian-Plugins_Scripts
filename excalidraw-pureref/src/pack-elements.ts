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

/** One placeable box: an id plus the size of its (rotation-aware) bounding box. */
interface SizedItem {
	id: string;
	w: number;
	h: number;
	/** The element's original AABB top-left, so a target maps back to a translation. */
	ox: number;
	oy: number;
}

/** Row-based (shelf) layout of items into rows no wider than `maxWidth`. */
interface Shelf {
	pos: Map<string, { x: number; y: number }>;
	width: number;
	height: number;
}

/**
 * Greedy next-fit-decreasing-height shelf pack: fill a row left-to-right until
 * the next item would exceed `maxWidth`, then start a new row below. Items are
 * top-aligned within their row; rows are separated by `gap`. Positions are local
 * (top-left origin at 0,0).
 */
function shelfPack(items: SizedItem[], maxWidth: number, gap: number): Shelf {
	const pos = new Map<string, { x: number; y: number }>();
	let x = 0;
	let y = 0;
	let rowHeight = 0;
	let width = 0;
	for (const it of items) {
		// x already carries the trailing gap from the previous item, so this test
		// counts the inter-item gap. A row's first item (x === 0) never wraps.
		if (x > 0 && x + it.w > maxWidth + 1e-6) {
			y += rowHeight + gap;
			x = 0;
			rowHeight = 0;
		}
		pos.set(it.id, { x, y });
		width = Math.max(width, x + it.w);
		x += it.w + gap;
		rowHeight = Math.max(rowHeight, it.h);
	}
	return { pos, width, height: y + rowHeight };
}

/**
 * PureRef-style "Optimal" arrange (Ctrl+Shift+P): re-lays the selection into a
 * compact, roughly-square 2D block, top-left anchored where the selection
 * currently sits. Unlike the gravity pack this ignores current arrangement and
 * ordering entirely — it packs purely for compactness (matching PureRef, whose
 * "By name/order/addition" are the ordered variants). Deterministic, so pressing
 * again on an already-optimal block is a no-op.
 *
 * Method: sort by height (tallest first) for tight shelves, then try a range of
 * target row widths and keep the layout whose bounding box is closest to square
 * (ties broken toward smaller area). Sizes are never changed.
 */
export function planOptimalPack(elements: PackElement[], gap: number): PackMove[] {
	if (elements.length < 2) return [];

	const aabbs = elements.map(elementAABB);
	const anchorX = Math.min(...aabbs.map((r) => r.minX));
	const anchorY = Math.min(...aabbs.map((r) => r.minY));

	const items: SizedItem[] = aabbs.map((r) => ({
		id: r.id,
		w: r.maxX - r.minX,
		h: r.maxY - r.minY,
		ox: r.minX,
		oy: r.minY,
	}));

	// Tallest-first shelves waste the least vertical space. Deterministic tie-break.
	const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w || (a.id < b.id ? -1 : 1));

	const maxItemWidth = Math.max(...sorted.map((it) => it.w));
	const totalRowWidth = sorted.reduce((s, it) => s + it.w, 0) + gap * (sorted.length - 1);

	// Candidate maximum row widths to try: a linear sweep from a single column up
	// to a single row, plus each prefix sum (the exact thresholds where a row's
	// item count changes). We keep whichever gives the most-square block.
	const candidates = new Set<number>();
	const STEPS = 120;
	for (let i = 0; i <= STEPS; i++) {
		candidates.add(maxItemWidth + ((totalRowWidth - maxItemWidth) * i) / STEPS);
	}
	let running = 0;
	for (const it of sorted) {
		running += it.w;
		candidates.add(running);
		running += gap;
	}

	let best: Shelf | null = null;
	let bestRatio = Infinity;
	let bestArea = Infinity;
	for (const maxWidth of candidates) {
		const shelf = shelfPack(sorted, maxWidth, gap);
		const ratio = Math.max(shelf.width, shelf.height) / Math.min(shelf.width, shelf.height);
		const area = shelf.width * shelf.height;
		if (ratio < bestRatio - 1e-9 || (Math.abs(ratio - bestRatio) < 1e-9 && area < bestArea)) {
			best = shelf;
			bestRatio = ratio;
			bestArea = area;
		}
	}
	if (!best) return [];

	const moves: PackMove[] = [];
	for (const it of items) {
		const p = best.pos.get(it.id);
		if (!p) continue;
		const dx = anchorX + p.x - it.ox;
		const dy = anchorY + p.y - it.oy;
		if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) moves.push({ id: it.id, dx, dy });
	}
	return moves;
}
