/**
 * Overlap-aware Bring Forward / Send Backward. Deliberately free of
 * Obsidian/Excalidraw imports, like pack-elements.ts, so the reordering can be
 * reasoned about in isolation; excalidraw-view.ts does the API glue.
 *
 * Excalidraw's native Ctrl+]/Ctrl+[ moves the selection exactly one array slot
 * per press (packages/element/src/zindex.ts, shiftElementsByOne), regardless of
 * whether that neighbor visually overlaps the selection at all. A selection
 * stuck behind a long run of elements it doesn't even touch still needs one
 * press per element in that run before anything appears to move. See
 * docs/behavior/overlap-aware-zorder.md.
 */

import { elementAABB, type PackElement } from "./pack-elements";

export type ZOrderDirection = "forward" | "backward";

/** The minimal element shape the z-order planner reads. */
export interface ZOrderElement extends PackElement {
	/** Nested Excalidraw group ids; a non-empty list means the fallback path applies. */
	groupIds?: readonly string[];
	frameId?: string | null;
}

const EPS = 1e-6;

function overlaps(a: ZOrderElement, b: ZOrderElement): boolean {
	const ra = elementAABB(a);
	const rb = elementAABB(b);
	return ra.minX < rb.maxX - EPS && ra.maxX > rb.minX + EPS && ra.minY < rb.maxY - EPS && ra.maxY > rb.minY + EPS;
}

/** Splits a sorted list of array indices into runs of consecutive indices. */
function toContiguousGroups(indices: number[]): number[][] {
	const groups: number[][] = [];
	for (const index of indices) {
		const last = groups[groups.length - 1];
		if (last && last[last.length - 1] === index - 1) last.push(index);
		else groups.push([index]);
	}
	return groups;
}

/**
 * Moves each contiguous run of selected, non-deleted elements past every
 * element ahead of it (or behind it, for "backward") that its bounding box
 * does NOT intersect, stopping just past the first one it does intersect --
 * or at the very front/back of the scene if nothing ever blocks it. Multiple
 * disjoint selected runs are each advanced independently, topmost-first for
 * "forward" and bottommost-first for "backward", mirroring how Excalidraw's
 * own shiftElementsByOne orders its groups so an earlier run's shift can't
 * invalidate a later run's indices.
 *
 * Returns `null` when there's nothing to move, or when any selected element
 * belongs to a group or a frame. Excalidraw's own z-order actions have real
 * group/frame-specific semantics (zindex.ts's getTargetIndex) that are
 * deliberately not reimplemented here -- callers should fall back to the
 * native Ctrl+]/Ctrl+[ handler in that case.
 */
export function planOverlapAwareZOrderMove(
	allElements: readonly ZOrderElement[],
	selectedIds: ReadonlySet<string>,
	direction: ZOrderDirection,
): readonly ZOrderElement[] | null {
	if (selectedIds.size === 0) return null;

	const selectedIndices: number[] = [];
	allElements.forEach((element, index) => {
		if (selectedIds.has(element.id) && !element.isDeleted) selectedIndices.push(index);
	});
	if (selectedIndices.length === 0) return null;

	for (const index of selectedIndices) {
		const element = allElements[index];
		if ((element.groupIds && element.groupIds.length > 0) || element.frameId) return null;
	}

	let groups = toContiguousGroups(selectedIndices);
	if (direction === "forward") groups = groups.reverse();

	let elements = allElements.slice();
	let moved = false;

	for (const group of groups) {
		// Re-resolve this run's current indices by id: an earlier run processed in
		// this same call may have shifted everything ahead of (or behind) it.
		const ids = group.map((index) => allElements[index].id);
		const indices = ids.map((id) => elements.findIndex((element) => element.id === id)).sort((a, b) => a - b);
		const runStart = indices[0];
		const runEnd = indices[indices.length - 1];
		const run = elements.slice(runStart, runEnd + 1);
		const overlapsRun = (candidate: ZOrderElement) => run.some((element) => overlaps(element, candidate));

		if (direction === "forward") {
			let stop = runEnd + 1;
			while (stop < elements.length && !overlapsRun(elements[stop])) stop++;
			if (stop >= elements.length) stop = elements.length - 1;
			const before = elements.slice(0, runStart);
			const displaced = elements.slice(runEnd + 1, stop + 1);
			if (displaced.length === 0) continue;
			const trailing = elements.slice(stop + 1);
			elements = [...before, ...displaced, ...run, ...trailing];
			moved = true;
		} else {
			let stop = runStart - 1;
			while (stop >= 0 && !overlapsRun(elements[stop])) stop--;
			const before = elements.slice(0, stop + 1);
			const displaced = elements.slice(stop + 1, runStart);
			if (displaced.length === 0) continue;
			const trailing = elements.slice(runEnd + 1);
			elements = [...before, ...run, ...displaced, ...trailing];
			moved = true;
		}
	}

	return moved ? elements : null;
}
