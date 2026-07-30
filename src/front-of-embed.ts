/**
 * Front-of-embed rendering -- deciding which non-embeddable elements need to be
 * mirrored onto the plugin's DOM overlay layer so they visually appear in front
 * of an embeddable, working around Excalidraw always painting embeddables above
 * the canvas-drawn layer regardless of scene z-order. See
 * docs/behavior/front-of-embed-rendering.md and docs/adr/0010-front-of-embed-rendering.md.
 *
 * Deliberately free of Obsidian/Excalidraw imports, like pack-elements.ts and
 * zorder.ts, so the eligibility rules can be reasoned about and unit-tested in
 * isolation; excalidraw-view.ts does the API glue (rasterizing candidates onto
 * the overlay canvas, dimming embeddable DOM nodes during a live gesture).
 */

import { elementAABB, type PackElement } from "./pack-elements";

/** The minimal element shape the front-of-embed planner reads. */
export interface FrontOfEmbedElement extends PackElement {
	/** Nested Excalidraw group ids; a non-empty list means this element bails out. */
	groupIds?: readonly string[];
	frameId?: string | null;
	/** Used by the view layer to skip re-rasterizing a candidate set that hasn't actually changed. */
	version?: number;
}

const EPS = 1e-6;

function overlaps(a: FrontOfEmbedElement, b: FrontOfEmbedElement): boolean {
	const ra = elementAABB(a);
	const rb = elementAABB(b);
	return ra.minX < rb.maxX - EPS && ra.maxX > rb.minX + EPS && ra.minY < rb.maxY - EPS && ra.maxY > rb.minY + EPS;
}

/**
 * Whether an element can ever qualify for front-of-embed rendering, ignoring
 * z-order/overlap entirely. Grouped and framed elements are excluded outright --
 * see the "Deliberate scope cut" in docs/behavior/overlap-aware-zorder.md for
 * the same reasoning: Excalidraw's group/frame z-order semantics are
 * non-trivial and out of proportion to the value of reimplementing them here.
 * Embeddables themselves never need to be "in front of" another embeddable via
 * this mechanism -- their mutual z-order is already handled natively.
 */
export function isFrontOfEmbedEligible(element: FrontOfEmbedElement): boolean {
	if (element.isDeleted) return false;
	if (element.type === "embeddable") return false;
	if (element.groupIds && element.groupIds.length > 0) return false;
	if (element.frameId) return false;
	return true;
}

function isEligibleEmbeddable(element: FrontOfEmbedElement): boolean {
	if (element.isDeleted) return false;
	if (element.type !== "embeddable") return false;
	if (element.groupIds && element.groupIds.length > 0) return false;
	if (element.frameId) return false;
	return true;
}

/**
 * The embeddables an eligible element could ever need front-of-embed treatment
 * against: every eligible embeddable positioned earlier in the scene's array
 * order (i.e. behind it, per Bring to Front/Send to Back semantics) than the
 * given element id. Overlap is not tested here -- this is the "z-order says
 * this element is already in front" half of the check, meant to be computed
 * once (e.g. at gesture start) and then combined with a cheap, repeated
 * overlap test as the element's live geometry changes (e.g. on every
 * pointer-move of a drag/resize/rotate/draw gesture).
 */
export function embeddablesBehind(
	allElements: readonly FrontOfEmbedElement[],
	elementId: string,
): FrontOfEmbedElement[] {
	const behind: FrontOfEmbedElement[] = [];
	for (const element of allElements) {
		if (element.id === elementId) break;
		if (isEligibleEmbeddable(element)) behind.push(element);
	}
	return behind;
}

/** Filters a list of candidate embeddables down to the ones `element` currently overlaps. */
export function overlappingEmbeddableIds(
	element: FrontOfEmbedElement,
	candidateEmbeddables: readonly FrontOfEmbedElement[],
): string[] {
	return candidateEmbeddables.filter((embeddable) => overlaps(element, embeddable)).map((embeddable) => embeddable.id);
}

/**
 * The full "at rest" pass: every eligible element that overlaps at least one
 * eligible embeddable positioned behind it in scene z-order. This is the set
 * that should be rasterized onto the front-of-embed overlay layer; everything
 * else renders only in Excalidraw's normal canvas layer as usual.
 *
 * Deliberately does not distinguish *which* embeddable(s) an element is in
 * front of, or attempt to slice the overlay by depth -- a board with multiple
 * embeddables at interleaved depths (an element meant to sit in front of one
 * embeddable but behind another) is a documented known limitation, not solved
 * here. See "Known limitations" in docs/behavior/front-of-embed-rendering.md.
 */
export function planFrontOfEmbedCandidates(allElements: readonly FrontOfEmbedElement[]): ReadonlySet<string> {
	return new Set(planFrontOfEmbedOverlaps(allElements).keys());
}

/**
 * Same eligibility pass as planFrontOfEmbedCandidates, but keeps which
 * embeddable(s) each qualifying element overlaps rather than collapsing to a
 * flat set of ids. Shared by both halves of the mechanism that read this
 * mapping for a different purpose: the at-rest pass rasterizes each
 * qualifying element onto the overlay canvas; the live-gesture pass dims
 * exactly the embeddable DOM nodes a currently-moving/drawing element
 * overlaps, using this same z-order + overlap rule so what gets dimmed during
 * a gesture always matches what would be rasterized if the gesture ended
 * right now.
 */
export function planFrontOfEmbedOverlaps(
	allElements: readonly FrontOfEmbedElement[],
): ReadonlyMap<string, readonly string[]> {
	const result = new Map<string, readonly string[]>();
	const embeddablesSoFar: FrontOfEmbedElement[] = [];

	for (const element of allElements) {
		if (isEligibleEmbeddable(element)) {
			embeddablesSoFar.push(element);
			continue;
		}
		if (!isFrontOfEmbedEligible(element)) continue;
		if (embeddablesSoFar.length === 0) continue;
		const overlapping = overlappingEmbeddableIds(element, embeddablesSoFar);
		if (overlapping.length > 0) result.set(element.id, overlapping);
	}

	return result;
}
