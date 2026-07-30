# Front-of-embed rendering

## Scope

Applies to every non-embeddable element type (freedraw, arrow, line,
rectangle, ellipse, text, image) against every embeddable type (video, PDF,
markdown embed, web iframe), in both the main Obsidian view and the editable
Popout. See [ADR 0010](../adr/0010-front-of-embed-rendering.md) for why this
is built as a plugin-owned mechanism rather than a patch to Excalidraw's
render pipeline, and
[excalidraw-embeddable-z-order-limitation.md](../integrations/excalidraw-embeddable-z-order-limitation.md)
for the upstream root cause this works around.

## Problem this solves

Excalidraw always renders embeddables above the canvas-drawn layer,
regardless of scene z-order — normally this means nothing can ever be drawn
or placed in front of a video/PDF/markdown/web embed. This is this plugin's
core use case (annotating reference media on a Board), so it's addressed
directly rather than left as a pure upstream limitation.

## Behavior

- **Bring to Front / Send to Back work as expected against embeddables.**
  Selecting an image (or any element) and using the normal z-order commands
  moves it in the scene array exactly as before; if that puts it ahead of an
  embeddable it overlaps, it now actually renders in front of it. Sending it
  back behind the embeddable removes it from the front-of-embed set again.
- **No special mode or toggle.** Whether an element renders in front of an
  embeddable is driven entirely by existing scene z-order plus whether its
  bounds overlap the embeddable — there is nothing new for the user to turn
  on, and no plugin setting to disable it in v1.
- **Live feedback while drawing, dragging, resizing, or rotating.** When any
  of these gestures is active on an element whose bounds currently overlap an
  embeddable, that embeddable is temporarily dimmed to a fixed opacity so the
  user can see Excalidraw's live rendering through it. The set of dimmed
  embeddables updates continuously as the element moves — only what's
  currently overlapped is dimmed. Full opacity is restored once the gesture
  ends and the finished result is rasterized onto the front-of-embed layer.
- **Nothing is persisted to the `.excalidraw` file.** Front-of-embed status is
  recomputed from ordinary element data (array order + bounding-box overlap)
  on load and after every relevant mutation — a file opened in vanilla
  Excalidraw or another tool looks and behaves the same as before.

## Deliberate scope cuts

- **Groups, frames, and bound-text/container pairs bail out entirely** — same
  precedent as [overlap-aware-zorder.md](overlap-aware-zorder.md). If any
  element in a front-of-embed candidate has a non-empty `groupIds`, a
  `frameId`, or `editingGroupId` is active, it's skipped and stays behind the
  embeddable as before.

## Known limitations

- **Multiple embeddables at interleaved depths aren't correctly represented.**
  The mechanism is a single flat layer rendered above *every* embeddable, not
  one sliced in at each embeddable's actual depth. An element meant to sit in
  front of one embeddable but behind another (e.g. `Embed A (back) → Image X
  → Embed B (front)`) will incorrectly render above both. Accepted as a known
  limitation — the common case of a single embeddable with elements in front
  of it is unaffected.
- **Clicking/selecting an element that's only visually in front via this
  mechanism still hits the embeddable underneath.** Excalidraw's own
  selection/pointer handling operates on the interactive canvas layer, which
  remains below the embeddable DOM node; there is no pointer-event routing
  yet to detect a click aimed at front-of-embed content and redirect it to
  the real element instead of the embeddable. No workaround exists today —
  select the element before it becomes visually occluded, or via Send to Back
  / Bring to Front toggling, or the outline/selection panel if applicable.
