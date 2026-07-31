/**
 * Front-of-embed rendering for the read-only transparent window -- the geometry
 * half, kept free of Obsidian/Excalidraw imports so it can be unit-tested like
 * front-of-embed.ts and pack-elements.ts. board-render.ts does the API glue.
 *
 * The editable view masks Excalidraw's own canvas because that canvas is the
 * only place the elements have been drawn. The read-only window has no canvas
 * at all: it displays a static SVG export of the Board, with live media painted
 * over it. So there is nothing to mask -- the same elements are simply exported
 * a second time into a layer stacked above the media, which is exact by
 * construction (it is Excalidraw's own renderer, at vector resolution) rather
 * than exact to within a dilation.
 *
 * The candidate set is deliberately `planFrontOfEmbedCandidates`, the same one
 * the editable view uses, so a Board looks the same either side of the F10
 * switch. Its remaining bail-out earns its keep here too even though nothing
 * is being masked: a framed element re-exported without its frame would lose
 * the frame's clip. A *bound or elbowed* arrow is fine re-exported alone --
 * see `isFrontOfEmbedEligible` in `front-of-embed.ts` for why its `points`
 * don't need the bound element present to be correct.
 */

import { isFrontOfEmbedEmbeddable, planFrontOfEmbedCandidates, type FrontOfEmbedElement } from "./front-of-embed";
import { elementAABB, type Rect } from "./pack-elements";

export interface ReadOnlyFrontLayerPlan {
	/** The elements to export into the front layer, in scene order. */
	candidates: readonly FrontOfEmbedElement[];
	/** Where that layer is allowed to paint: the embeddables it exists to cover. */
	clip: readonly Rect[];
}

/**
 * What the read-only window needs to render in front of its media overlays, or
 * null when the Board has nothing that qualifies (which is most Boards, and
 * costs a second export nowhere).
 */
export function planReadOnlyFrontLayer(
	elements: readonly FrontOfEmbedElement[],
): ReadOnlyFrontLayerPlan | null {
	const candidates = planFrontOfEmbedCandidates(elements);
	if (candidates.length === 0) return null;
	const clip = elements.filter(isFrontOfEmbedEmbeddable).map(elementAABB);
	// A candidate exists only because it sits in front of one of these, so an
	// empty clip here would mean the two disagree -- bail rather than paint
	// unclipped.
	if (clip.length === 0) return null;
	return { candidates, clip };
}

/** Two decimals is well under a scene unit; the payload crosses an IPC boundary as text. */
function round(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * The clip region for the front layer, as SVG path data in the layer's own local
 * coordinates (scene coordinates minus the layer's origin).
 *
 * The layer is clipped to the embeddables because it is a *second* copy of
 * elements the base export already drew. Left unclipped, every candidate would
 * be painted twice: invisible for an opaque element, but a semi-transparent one
 * would composite against itself, and a candidate would cover any later element
 * that overlaps it away from the embeddable. Clipped, each copy owns a disjoint
 * region -- the front one over the embeddable, the base one everywhere else.
 *
 * Rectangles are the same rotation-aware AABBs `planFrontOfEmbedCandidates` used
 * to decide the element was in front of the embeddable in the first place, so
 * the clip can never be tighter than the test that admitted the candidate.
 */
export function frontLayerClipPath(rects: readonly Rect[], originX: number, originY: number): string {
	return rects
		.map((rect) => {
			const x0 = round(rect.minX - originX);
			const y0 = round(rect.minY - originY);
			const x1 = round(rect.maxX - originX);
			const y1 = round(rect.maxY - originY);
			return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
		})
		.join("");
}
