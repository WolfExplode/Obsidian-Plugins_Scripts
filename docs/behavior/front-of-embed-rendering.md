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
- **Sloppiness, stroke style and pen settings are honoured.** The mask follows
  the path Excalidraw actually drew, so architect, artist and cartoonist all mask
  correctly, dashed and dotted strokes mask as dashes and dots rather than as a
  solid line, and a stroke drawn with a custom pen masks with that pen's own
  profile.
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
- **Selection needs nothing from this mechanism — it already works.** Clicking
  an element where it overlaps an embeddable selects that element, not the
  embeddable, and it stays draggable there. This was expected to be a
  limitation (the overlay is a `pointer-events: none` canvas, and Excalidraw
  hit-tests on its interactive canvas *below* the embeddable's DOM node), but
  an inactive embeddable's container is itself `pointer-events: none` (verified
  live, 2026-07-30), so the click reaches the interactive canvas and Excalidraw
  hit-tests it in ordinary scene z-order — where the front element already
  wins. No pointer-event routing or hit-test router is needed.
- **The mask follows Excalidraw's own placement, quirks included.** Excalidraw
  renders a line, arrow or freedraw into a per-element canvas and then blits it,
  and the two halves of that disagree when the drawn geometry starts *after* the
  element's `x`/`y` on an axis: `generateElementCanvas` clamps its offset to 0
  (`element.y > y1 ? distance(element.y, y1) : 0`) while `drawElementFromCanvas`
  blits as though the content began at `y1`, so the element is painted
  `y1 - element.y` too low. Mostly visible on a dashed or dotted **cartoonist**
  stroke, which is drawn as a single rough.js pass with unpinned vertices and so
  can sit entirely below its own first point. Measured live (2026-07-30): 1.41
  scene units, enough that the mask straddled the stroke — background copied
  along the top of every dash, the bottom of the stroke left behind. The mask
  now applies the same displacement, via `maskPlacement`.
- **A stroke's box is where the stroke is, not where it started.** Excalidraw
  pins a line/arrow/freedraw's `x`/`y` to its *first point*, so a scribble drawn
  right-to-left or bottom-to-top extends left and up from there. Both the
  overlap test and the mask's rotation pivot go through `geometryOffset`
  (`pack-elements.ts`) for this. Taking `x`/`y` as the top-left instead gave a
  box hanging off the starting point, down and to the right — which is what made
  a big scribble render in front only when the embeddable happened to sit inside
  that phantom box (fixed 2026-07-30).
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
- **Text and images keep a reconstructed mask.** Excalidraw exports text as
  `<text>` and images as `<image>`, neither of which is path geometry, so those
  two types are always masked from the shapes derived in `front-of-embed.ts`
  rather than from emitted paths. Text is masked glyph-accurately; an image
  masks as its whole box.
- **The reconstructed fallback is approximate where it is used.** For the frame
  or two before an element's geometry has been fetched, the mask comes from the
  ports, and a few of their cases are known to be imperfect: a
  constant-pressure freedraw sits a mean of 0.43 scene units off (see
  `CONSTANT_VARIABILITY_PRESSURE`, a fitted constant), ellipses and rounded
  diamonds are not reproduced at all and fall back to a jitter allowance, the
  Obsidian plugin's custom pen options are not stored on the element so a
  highlighter stroke gets the wrong profile, and a dashed mask's phase can drift
  because rough.js restarts it per subpath where the fallback traces one
  continuous path. None of these persist: once the fetched geometry lands it
  replaces all of them.
- **Hachure and cross-hatch fills mask as solid.** `fillStyle` is read for
  whether a fill exists but a hatched interior still masks as a slab rather than
  as its lines, because the mask fills the emitted fill path rather than
  following its hatching.
- **Bound and elbowed arrows bail out.** Excalidraw does not draw these along
  their own `points` — a bound endpoint is pulled back to the bound element's
  boundary, and an elbowed arrow is re-routed as orthogonal segments — so their
  drawn path can't be masked from element data. They stay behind the embeddable.
  An ordinary unbound arrow works normally.

## Where the mask geometry comes from

The mask needs to know exactly where Excalidraw drew each element. It gets that
from Excalidraw itself, with a plugin-side reconstruction as a fallback.

**Primary: what Excalidraw emits.** `exportToSvg` on a single element returns
the real path data, which `new Path2D(d)` parses directly, and its coordinates
are already element-local — the `<g>` transform is SVG layout only. Each path is
filled or stroked exactly as Excalidraw marked it, at the width and dash pattern
it marked, so no shape knowledge and no jitter allowance are involved. See
`emitted-geometry.ts`.

This is asynchronous and there is no alternative: of `ExcalidrawLib`'s 105
exports none expose per-element geometry synchronously, the Obsidian plugin's
`ExcalidrawAutomate` has nothing shape-related, and Excalidraw's internal
`ShapeCache` is unreachable. So it is necessarily a cache. Two things keep that
cheap enough to be invisible:

- **The cache key is the element's geometry, not its `version`.** Moving,
  rotating, re-colouring and re-ordering leave it untouched, so no re-export
  happens; only drawing and resizing invalidate it. This matters because a scene
  change fires on every pointer move of a drag.
- **A cached path is only drawn if its signature still matches the element.** A
  resize therefore falls back to the reconstruction for a frame rather than
  masking the element's previous size.

Measured on a live board (2026-07-30): 0.72 ms per element to export, and no
perceptible lag while drawing or resizing.

**Fallback: reconstruction.** `rough.ts` and `freehand.ts` port rough.js's and
perfect-freehand's geometry so a frame with nothing cached yet still masks
correctly instead of flashing. They are validated against `exportToSvg` output
rather than against upstream source, and several match it exactly — but they are
reconstructions of code that is not in the Obsidian Excalidraw plugin's bundle,
so they can drift silently when upstream changes. That is tolerable for a
fallback and would not be as the primary path; see the scope cuts above for
where they are known to be imperfect.

`__eprEmittedGeometry(false)` switches the primary path off from the console, so
the two can be compared on the same board without a rebuild.

## Known limitations

- **Multiple embeddables at interleaved depths aren't correctly represented.**
  The mechanism is a single flat layer rendered above *every* embeddable, not
  one sliced in at each embeddable's actual depth. An element meant to sit in
  front of one embeddable but behind another (e.g. `Embed A (back) → Image X
  → Embed B (front)`) will incorrectly render above both. Accepted as a known
  limitation — the common case of a single embeddable with elements in front
  of it is unaffected.
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
