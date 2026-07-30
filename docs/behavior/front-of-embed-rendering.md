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
- **A constant-pressure freedraw is masked approximately.** Measured against
  Excalidraw's own output (2026-07-30, `exportToSvg` on a live 636-point
  stroke), `freehand.ts` reproduces a **variable**-pressure stroke exactly — a
  mean deviation of **0.012 scene units**, 1266 outline points against 1267,
  which is the SVG's own 2-decimal rounding. A **constant**-pressure stroke sits
  a mean of **0.43** off, with 1268 points against 1345.

  `CONSTANT_VARIABILITY_PRESSURE` is fitted, not read from Excalidraw: pinning
  pressure to 0 fits far better than the alternatives (`thinning: 0` gives 1.95,
  an unpinned `simulatePressure: false` gives 3.92), but nothing tried reaches
  the variable case's exactness, and no combination of `size`, `thinning`,
  `smoothing`, or `streamline` reproduces the 1345-point count. perfect-freehand
  is *not* in the Obsidian Excalidraw plugin's `main.js` — `ExcalidrawLib` is
  supplied from elsewhere — so the port was reconstructed rather than diffed,
  and closing this means finding that build.
- **Custom pens are only partly accounted for.** The element's own
  `strokeOptions` (`variability`, `streamline`) are read, but the Obsidian
  Excalidraw plugin's pens carry more than that — its highlighter uses
  `thinning: 1`, `constantPressure`, and an extra `outlineWidth: 4` outline —
  and those are not stored on the element, so a highlighter stroke will be
  masked with the wrong profile.
- **Dashed and dotted strokes mask as solid.** `strokeStyle` is not read, so the
  mask is continuous where the drawn stroke has gaps, painting scene background
  into every gap over an embeddable. Same class as the constant-pressure bug:
  the mask has to copy the element's own draw settings, not assume defaults.
  Reproducing it means matching rough.js's dash geometry.
- **Hachure and cross-hatch fills mask as solid.** `fillStyle` is not read
  either, so a hatched interior masks as a slab rather than as its lines.
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
- **A rim of scene background is copied along with the element** — *known bug,
  deferred.* Excalidraw's static canvas is fully opaque: it is the view
  background with the scene drawn onto it, so every mask pixel that isn't
  exactly on the element blits board background over the embed. The mask must
  be grown past the element's exact geometry (hand-drawn strokes overshoot their
  nominal path, and the rendered pixels are antialiased — masking exactly clips
  a hairline off every edge), so some rim is unavoidable as long as the
  mechanism copies from an opaque source.

  Measured live on 2026-07-30: **39.7% of the overlay's opaque pixels were
  background rather than element**, reading as a ~5px dark outline around every
  stroke at 38% zoom. Correcting the mask geometry it was compensating for —
  rough.js's own curve for curved linear elements, perfect-freehand's real
  stroke width for freedraw, roughness-scaled jitter, and a 0.5px rather than
  1.5px antialias allowance — brought that to **13.6%**.

  What remains is inherent to mask-and-blit; tuning the dilation shrinks it but
  cannot remove it. The candidate fix is to stop compositing over the
  embeddable and instead **punch holes in it**: give each
  `.excalidraw__embeddable-container` a `mask-image: url(#…)` referencing a live
  in-document `<svg><mask>` holding the element shapes, so Excalidraw's own
  canvas — already below the embeddable — shows through unaltered. Verified that
  Chromium accepts the reference (2026-07-30); not verified that masked
  iframes/videos composite correctly. That approach would also retire the two
  limitations below, since each embeddable would carry its own mask built only
  from the elements above *it*, and nothing would be re-composited against the
  scene background.
- **Semi-transparent and hachure-filled elements composite against the scene
  background, not the embeddable.** The copied pixels are Excalidraw's already
  composited output, so a 50%-opacity element over an embeddable shows itself
  blended with the view background rather than with the video underneath, and a
  hachure fill's gaps show background rather than embed content.
