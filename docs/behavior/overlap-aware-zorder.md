# Overlap-aware Bring Forward / Send Backward

## Scope

Applies to **Ctrl/Cmd+]** (Bring Forward) and **Ctrl/Cmd+[** (Send Backward)
only, in both the normal Excalidraw view and an editable PureRef Popout.
**Ctrl+Shift+]/[** (Bring to Front / Send to Back) are deliberately untouched.

## Problem this solves

Excalidraw's native Bring Forward / Send Backward
(`packages/element/src/zindex.ts`, `moveOneRight`/`moveOneLeft` →
`shiftElementsByOne`) moves the selection exactly one array slot per press —
`getTargetIndex` just picks `boundaryIndex + 1` (or `- 1`), with no concept of
whether that neighbor visually overlaps the selection. Two overlapping piles of
images, where the target element starts behind a long run of elements from an
unrelated pile, need one press per element in that unrelated run before
anything visibly changes.

Bring to Front / Send to Back (`moveAllRight`/`moveAllLeft` →
`shiftElementsToEnd`) don't have this problem — they jump the selection
straight to `elements.length - 1` (or `0`) in a single native call, so they're
left alone here.

## Behavior

One press of Ctrl+]/Ctrl+[ moves each contiguous run of selected, non-deleted
elements past every element ahead of it (or behind it) whose axis-aligned
bounding box does **not** intersect the run's bounding box, stopping just past
the first one that does. If nothing ahead ever overlaps, the run goes all the
way to the front (or back) of the scene, same as Bring to Front would.

A selection with multiple disjoint depths (e.g. two elements selected at very
different z-positions) advances each contiguous run independently in the same
keypress — same grouping rule as upstream's `toContiguousGroups`.

## Implementation

- [zorder.ts](../../src/zorder.ts) — pure geometry + reordering logic,
  `planOverlapAwareZOrderMove`. Free of Obsidian/Excalidraw imports, mirroring
  [pack-elements.ts](../../src/pack-elements.ts)'s style (and reusing its
  rotation-aware `elementAABB` for the overlap test).
- [excalidraw-view.ts](../../src/excalidraw-view.ts)'s
  `bringSelectionPastOverlap` — API glue: reads the scene + selection, calls
  the planner, writes the result back via `updateScene` as one undoable
  history entry (same `captureUpdate: "IMMEDIATELY", commitToHistory: true`
  pattern as `applyPack`/`adjustSelectedElementsOpacity`).
- [zorder-keys.ts](../../src/zorder-keys.ts)'s `attachZOrderKeydown` —
  capture-phase `keydown` listener, wired per-window (main window + each
  Popout) in `main.ts`/`popout-manager.ts`, same as `attachPackKeydown`.

Reordering is done by handing `updateScene` a fully-reordered `elements`
array — no manual fractional-index bookkeeping is needed. Excalidraw's
`Scene` re-derives each element's fractional `index` field from whatever array
order it's given (`syncInvalidIndices`, called from `Scene`'s elements setter
in `packages/element/src/Scene.ts`) — array order is the source of truth, the
`index` field is a cache kept in sync with it. This is the same mechanism
`packages/element/src/zindex.ts`'s own `shiftElementsByOne` relies on
(`syncMovedIndices`), so passing a freshly-ordered array through the public
`updateScene` API is a sanctioned way to reorder, not a workaround.

## Deliberate scope cut: groups and frames

`bringSelectionPastOverlap` returns `false` (a no-op) whenever `editingGroupId`
is set, or any selected element has a non-empty `groupIds` or a `frameId`. In
that case `attachZOrderKeydown` does **not** consume the keypress, so
Excalidraw's own native handler still runs normally.

Reason: upstream's `getTargetIndex` has real, non-trivial group/frame z-order
rules (siblings-only movement while editing a group, frame-children ranges
moving as a block, bound-text/container pairing) — see
[zindex.ts:205-311](../../reference/excalidraw-master/packages/element/src/zindex.ts#L205-L311).
Reimplementing all of that alongside overlap-awareness was judged materially
riskier than the value of covering that case; the common PureRef case (a pile
of loose, ungrouped images) is what this feature targets. If group/frame
overlap-skipping is ever needed, extend `planOverlapAwareZOrderMove`'s bail-out
condition instead of trying to patch around it.

## Known edge

Overlap is tested via `elementAABB`'s rotation-aware **axis-aligned** bounding
box (the same approximation `pack-elements.ts` uses), not exact per-shape
geometry. For rotated non-rectangular elements this can register a false
overlap (two rotated shapes whose AABBs touch but whose actual outlines don't),
which only makes the jump stop one element earlier than strictly necessary —
never wrong-direction, never skips a real overlap.
