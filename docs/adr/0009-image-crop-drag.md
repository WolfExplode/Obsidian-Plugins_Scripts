---
status: accepted
---

# PureRef-style hold-C drag crop, built on Excalidraw's native crop

## Decision

Holding **C** and dragging a rectangle over the Board crops images to that
rectangle, mirroring PureRef's crop gesture. If images are selected, all of them
are cropped; if nothing is selected, the gesture is a no-op.
It is bound per window and so works in the main window and every Popout.

Upright images are driven through Excalidraw's own `crop` element field. Rotated
images require a generated viewport PNG because a screen-aligned polygon cannot
be represented by that axis-aligned field. In both cases the full source image
is retained, and the change is a single undoable step.

## Invariants and consequences

- A crop intersects the image's current visible region; it never re-exposes
  pixels removed by an earlier crop. Uncrop remains an explicit operation.
- Flipped upright images remain native crops, with source coordinates adjusted
  for the flip.
- Rotated crops compose from the retained original source rather than stacking
  raster generations. The accumulated visible polygon and source relationship
  are stored in `customData`.
- Generated attachments are registered before use and deleted only after the
  live scene stops referencing them. See the
  [generated-image lifecycle](../integrations/obsidian-excalidraw-generated-images.md).
- The implementation uses the public Excalidraw runtime surface, consistent
  with ADR 0001; it does not import Excalidraw internals.

User-visible gestures and uncrop behavior are documented in
[Interaction overrides](../behavior/user-interaction-overrides.md). Coordinate
math, file registration, replacement, and cleanup belong in implementation and
integration documentation rather than this decision record.
