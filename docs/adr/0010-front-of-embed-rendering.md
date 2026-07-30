---
status: accepted
---

# Front-of-embed rendering masks and blits Excalidraw's own canvas

Excalidraw's embeddable elements (video/PDF/markdown/web embeds) always render
above canvas-drawn elements regardless of scene z-order — a confirmed upstream
limitation, see
[excalidraw-embeddable-z-order-limitation.md](../integrations/excalidraw-embeddable-z-order-limitation.md).
That doc treats it as an accepted limitation "unless it starts actively
blocking a specific workflow." It now does: this plugin's core PureRef-style
use case is annotating over reference media, and drawing or placing anything
in front of a video/web embed was structurally impossible.

## Decision

Build Front-of-embed rendering as a plugin-owned mechanism, not a patch to
Excalidraw internals:

- A DOM `<canvas>` mounted as the last child of the `.excalidraw` root. Verified
  live: embeddable containers and the interactive canvas both sit at `z-index: 2`
  and the static canvas at `1`, so an overlay at `z-index: 2` appended after the
  embeddables wins on DOM order — while `--zIndex-svgLayer` and
  `--zIndex-wysiwyg` (both 3) correctly stay above it, which a `z-index: 3`
  overlay would have covered.
- Whenever a non-embeddable element's position in the scene array is already
  in front of an embeddable it overlaps (AABB overlap, same test as
  [overlap-aware-zorder.md](../behavior/overlap-aware-zorder.md)'s
  `elementAABB`), **Excalidraw's own static canvas is copied onto the overlay
  through an alpha mask of that element's shape**. Nothing is re-rendered: the
  element has already been painted, this frame, at the current zoom, in the
  current theme, into a canvas that is a sibling of the overlay. The overlay
  paints the mask, then `drawImage`s the static canvas with
  `globalCompositeOperation = "source-in"`.
- The mask is built from element geometry alone, not from a renderer: rect for
  images, outline-or-filled path for shapes, the element's own `points` for
  linear elements (curve-smoothed when `roundness` is set), and **the actual
  glyphs** for text, via `ExcalidrawLib.getFontString`/`getFontMetrics` and the
  same line offsets `renderElement.ts` uses. Fidelity of the mask only has to be
  good to within its dilation, because every pixel drawn comes from Excalidraw.
- Per ADR 0001, this plugin never imports Excalidraw's npm package directly — it
  only reads the runtime surface the Excalidraw plugin already exposes in that
  window (`window.ExcalidrawLib`, `excalidrawAPI`). Viewport sync needs no
  subscription: the compositing loop is a `requestAnimationFrame` loop that
  re-reads `scrollX`/`scrollY`/`zoom.value` each frame, and it only runs while
  there is at least one candidate to draw. Nothing is persisted to the
  `.excalidraw` file; the candidate set is derived from existing element data
  and recomputed on each scene change (Excalidraw's own `onChange`), never per
  frame.
- Front-of-embed rendering applies uniformly to every embeddable type and
  every non-embeddable element type; there is no per-type scoping and no
  settings toggle in v1.

Because the overlay is a masked copy of live pixels rather than a snapshot, a
drag/resize/rotate/draw gesture needs no handling of its own: the copied pixels
move with the element because they *are* the element. There is no cache to
invalidate, no in-flight export to supersede, and no gesture state.

## Rejected alternatives

- **Patching Excalidraw's `renderEmbeddables`/canvas pipeline directly** —
  already rejected in the integrations doc as materially riskier and liable
  to break on every Excalidraw version bump.
- **Demoting the embeddable below the static canvas with CSS** — the tempting
  one-liner, since the embeddable container is only one z-index above the static
  canvas. It cannot work: `bootstrapCanvas`
  ([renderer/helpers.ts](../../reference/excalidraw-master/packages/excalidraw/renderer/helpers.ts))
  fills the static canvas with `viewBackgroundColor` unless it is exactly
  `"transparent"`, so a demoted embeddable would be hidden behind an opaque
  background rather than revealed. Verified live: the static canvas reads fully
  opaque (alpha 255) on a default `#ffffff` board.
- **Re-rendering the candidate elements asynchronously via
  `ExcalidrawLib.exportToBlob`** — built first, then replaced. It works, but
  every one of its problems traces to the export being asynchronous and
  therefore always behind the live scene: a bitmap/bounds pair that could
  desync (visible warping mid-drag), a token/pending-key cache to dedupe and
  supersede in-flight exports, a snapshot that had to be suppressed during
  gestures to avoid ghosting, a separate embeddable-dimming subsystem to give
  live feedback in its place, PNG round-trip blur when zoomed in, and a second
  bounding-box computation that had to agree with `exportToBlob`'s own. The
  static-canvas blit needs none of it. Kept on the
  `backup/front-of-embed-rasterize` branch.
- **A separate always-on-top transparent overlay window** — this plugin
  already solves a structurally similar problem this way (transparent
  read-only Popout, [ADR 0008](0008-editable-and-transparent-modes-use-separate-windows.md)).
  Rejected here because that surface is read-only; the goal is live drawing
  in the same editable view, which a second window can't provide.

## Consequences / deliberate scope cuts

- **Correct geometry is not enough; the mask has to be placed the way Excalidraw
  places the element**, quirks and all. A linear or freedraw element is painted
  slightly off its own geometry whenever the drawn stroke starts after the
  element's origin — an upstream bug in `generateElementCanvas` /
  `drawElementFromCanvas`, traced in
  [Excalidraw linear-element canvas offset](../integrations/excalidraw-linear-element-canvas-offset.md).
  `maskPlacement` reproduces the displacement rather than trying to be "right"
  about it: the mask's job is to land on the pixels Excalidraw drew, not on the
  pixels it should have drawn. Same reason the rotation pivot comes from
  Excalidraw's bounds.

- **Framed elements bail out**; grouped elements and labelled shapes do not.
  The line is whether the element is drawn somewhere the mask can't follow. A
  frame *clips* its children and the mask has no clip, so a partly-clipped
  element would blit background from where the frame cut it off. Grouping, by
  contrast, changes nothing about how or where a member is drawn — and the
  group bail-out in `overlap-aware-zorder.md` is not precedent here, because
  that feature **reorders** elements (where upstream's group rules are
  non-trivial) while this one only reads the order that already exists.
  Similarly a shape's bound label is kept in absolute scene coordinates by
  `redrawTextBoundingBox`, so it masks as ordinary text; it rides on its
  container's verdict so the pair always crosses the embeddable together.
- **Bound, elbowed, and labelled arrows bail out**, one step further along the
  same reasoning: their `points` are not where Excalidraw draws them (a bound
  endpoint is pulled back to the bound element's boundary; an elbowed arrow is
  re-routed orthogonally), so a mask built from the points covers empty canvas.
  Verified live — it painted a band of scene background across the embeddable.
  An arrow *label* is the same problem twice: it is placed by
  `LinearElementEditor.getBoundTextElementPosition` rather than at its own
  `x`/`y`, and `drawElementFromCanvas` punches a label-shaped hole in the
  arrow's own blit that a solid stroke mask would fill with background.

  Both bail-outs are **deferred, not judged impossible** — each was scoped
  against upstream source on 2026-07-30 and the findings (what it would take,
  and why frames are the better-value half) are recorded under "Deliberate scope
  cuts" in
  [front-of-embed-rendering.md](../behavior/front-of-embed-rendering.md) rather
  than being re-derived. Read the `mask-image` candidate under "Known
  limitations" there first: it changes the shape of both.
- A board with multiple embeddables at interleaved depths (e.g. an element
  meant to sit in front of one embeddable but behind another) is not
  correctly represented — the overlay is a single flat layer above every
  embeddable, not multiple depth-sliced layers. Accepted as a known
  limitation, not solved here.
- Selection was expected to need a hit-test router — an element only visually
  in front would still hit the embeddable underneath — and does not. An
  inactive embeddable's container is `pointer-events: none` (verified live,
  2026-07-30), so a click passes through it to the interactive canvas, where
  Excalidraw hit-tests in scene z-order and the front element already wins.
  The overlay is `pointer-events: none` too and stays out of it entirely. No
  routing was written and none is planned.
- Because the copied pixels are Excalidraw's *composited* output, anything the
  scene already painted underneath a candidate — the view background, or an
  element sitting behind the embeddable — is copied along with it wherever the
  mask covers. This is invisible for opaque elements and shows as a faint rim
  around thin ones; see "Known limitations" in the behavior doc.
