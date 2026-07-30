# Front-of-embed rendering

## Scope

Applies to every non-embeddable element type (freedraw, arrow, line,
rectangle, ellipse, diamond, text, image) against every embeddable type (video,
PDF, markdown embed, web iframe), in both the main Obsidian view and the
editable Popout. See [ADR 0010](../adr/0010-front-of-embed-rendering.md) for why
this is built as a plugin-owned mechanism rather than a patch to Excalidraw's
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
- **What appears in front is the real element, not an approximation.** The
  mechanism copies Excalidraw's own rendered pixels through a mask of the
  element's shape, so what shows over the embeddable is identical to what
  Excalidraw drew — same colours, same theme, same hand-drawn stroke, crisp at
  any zoom.
- **Drawing, dragging, resizing, and rotating are live.** There is no snapshot
  and no gesture mode: the overlay recomposites every frame from the current
  canvas, so an element being dragged across an embeddable moves over it in real
  time, and a freedraw stroke appears over it as it is drawn.
- **Only the element occludes the embeddable, not its bounding box.** An
  unfilled rectangle shows the embeddable through its interior; text occludes
  only its glyphs; a stroke occludes only its own width. A filled shape occludes
  its interior, as expected.
- **Nothing is persisted to the `.excalidraw` file.** Front-of-embed status is
  recomputed from ordinary element data (array order + bounding-box overlap)
  on load and after every relevant mutation — a file opened in vanilla
  Excalidraw or another tool looks and behaves the same as before.
- **Costs nothing when unused.** The compositing loop runs only while at least
  one element actually qualifies, and stops itself again when none do.

## Deliberate scope cuts

- **Groups, frames, and container/bound-text pairs bail out entirely** — same
  precedent as [overlap-aware-zorder.md](overlap-aware-zorder.md). If a
  candidate has a non-empty `groupIds`, a `frameId`, a `containerId`, or bound
  text of its own, it's skipped and stays behind the embeddable as before. A
  labelled shape bails out as a pair, so it never renders in front with its
  label left behind.
- **Bound and elbowed arrows bail out.** Excalidraw does not draw these along
  their own `points` — a bound endpoint is pulled back to the bound element's
  boundary, and an elbowed arrow is re-routed as orthogonal segments — so their
  drawn path can't be masked from element data. They stay behind the embeddable.
  An ordinary unbound arrow works normally.

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
- **A thin rim of scene background is copied along with the element.** The mask
  is grown slightly past the element's exact geometry, because Excalidraw's
  hand-drawn strokes overshoot their nominal path and the rendered pixels are
  antialiased — masking exactly would clip a hairline off every edge. The rim is
  about a pixel wide on screen at any zoom, and is only noticeable against
  high-contrast embed content.
- **Semi-transparent and hachure-filled elements composite against the scene
  background, not the embeddable.** The copied pixels are Excalidraw's already
  composited output, so a 50%-opacity element over an embeddable shows itself
  blended with the view background rather than with the video underneath, and a
  hachure fill's gaps show background rather than embed content.
