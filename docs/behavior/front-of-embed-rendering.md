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
- **Grouped elements render in front like any other.** Grouping changes nothing
  about how or where Excalidraw draws a member, and Excalidraw both renders in
  array order and keeps a group's members contiguous in that array — so "after
  the embeddable" means the same thing for a group member as for a loose
  element. Each member is masked individually, so a group half over an
  embeddable shows exactly the half that overlaps. This is deliberately *not*
  the same call as the group bail-out in
  [overlap-aware-zorder.md](overlap-aware-zorder.md): that feature **reorders**
  elements, which is where upstream's group rules get non-trivial, while this
  one only reads the order that already exists.
- **A labelled shape renders in front with its label.** A rectangle, ellipse or
  diamond with text inside it qualifies normally, and its bound text travels
  with it: the label rides on its container's verdict rather than being tested
  on its own, so the two always cross the embeddable together. `redrawTextBoundingBox`
  keeps a shape-bound label's `x`/`y`/`angle` in absolute scene terms (rotation
  about the container's centre already baked in), so it needs no special
  placement — it masks as ordinary text. **Arrow labels are the exception** and
  bail out as a pair with their arrow; see the scope cuts below.
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
  paints a line, arrow or freedraw a little low and/or right of the geometry it
  generates for it, whenever the drawn stroke starts after the element's own
  `x`/`y` — an upstream bug, documented in full in
  [Excalidraw linear-element canvas offset](../integrations/excalidraw-linear-element-canvas-offset.md).
  It shows up on dashed and dotted **cartoonist** strokes, and at 1.41 scene
  units (measured live, 2026-07-30) it was enough for the mask to straddle the
  stroke: background copied along the top of every dash, the bottom of the
  stroke left behind. `maskPlacement` applies the same displacement, so the mask
  lands on the pixels Excalidraw actually drew.
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

- **Frames bail out entirely.** A candidate with a `frameId` is skipped and
  stays behind the embeddable. A frame *clips* its children and the mask has no
  clip of its own, so masking a partly-clipped element would copy scene
  background from wherever the frame cut it off. Embeddables inside a frame are
  likewise not treated as embeddables to be in front of. Groups are **not** a
  bail-out — see "Behavior" above.

  *Deferred, not blocked* (scoped 2026-07-30). The clip itself is nearly free:
  `frameClip`
  ([staticScene.ts:133](../../reference/excalidraw-master/packages/excalidraw/renderer/staticScene.ts#L133))
  is a translate, `roundRect(0, 0, w, h, FRAME_STYLE.radius / zoom)` and
  `clip()`, and the paint loop already establishes the scene→viewport transform
  it would sit inside. Frames can't rotate, so there is no pivot interaction.
  Three things make it a day's work rather than an hour's:
  - **Knowing *when* to clip.** `shouldApplyFrameClip`
    ([frame.ts:911](../../reference/excalidraw-master/packages/element/src/frame.ts#L911))
    has an easy half (element intersects or contains the frame) and a fiddly
    half about group members and `selectedElementsAreBeingDragged`. Skipping the
    fiddly half is not safe-by-default: clipping where Excalidraw didn't makes
    the overlay *lose* part of an element, which shows as the element being cut
    off mid-drag out of a frame.
  - **Framed embeddables** would have to start counting as embeddables to be in
    front of (`isEligibleEmbeddable` drops them today).
  - **The frame's own border and name label** are chrome this mechanism never
    masks, so a frame drawn over an embeddable stays behind it either way.
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
- **Bound, elbowed, and labelled arrows bail out.** Excalidraw does not draw
  these along their own `points` — a bound endpoint is pulled back to the bound
  element's boundary, and an elbowed arrow is re-routed as orthogonal segments —
  so their drawn path can't be masked from element data. A *labelled* arrow
  bails out as a pair with its label, for the same reason on both halves: the
  label's own `x`/`y` are ignored in favour of
  `LinearElementEditor.getBoundTextElementPosition`, and `drawElementFromCanvas`
  punches a label-shaped hole in the arrow's blit, so masking the arrow's stroke
  across the label would copy background out of that hole. All of these stay
  behind the embeddable; an ordinary unbound, unlabelled arrow works normally.

  *Deferred as low-value* (scoped 2026-07-30), and the reason is worth recording
  because the effort estimate is misleading on its own. **Placement is the easy
  half**: `getCommonBounds` builds its own elements map from whatever array it
  is handed
  ([bounds.ts:1017](../../reference/excalidraw-master/packages/element/src/bounds.ts#L1017)),
  so `getCommonBounds([arrow, label])` resolves the container and returns the
  label's *drawn* position through `getBoundTextElementPosition` — no port to
  write, and `maskPlacement`'s shift already has somewhere to put it.
  (`LinearElementEditor` itself is *not* on `ExcalidrawLib`; verified live
  2026-07-30, only `getContainerElement`, `getBoundTextMaxWidth` and the bounds
  helpers are.) **The hole-punch is the hard half**: reproducing it means
  painting the pair as a unit in a fixed order — arrow mask, clear the label
  rect in *scene* space, then the label's glyphs — which gives up the paint
  loop's one-element-at-a-time independence.

  What makes it not worth that: a labelled arrow is usually a *connector*, which
  means it is also a **bound** arrow, and bound arrows bail out for a separate
  and much harder reason. So the case this would actually unlock is a labelled,
  unbound, non-elbowed arrow that happens to cross an embeddable — the narrowest
  target of any cut on this list, behind the most invasive change.

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
  scene background. It reshapes the two deferred scope cuts as well: the frame
  and labelled-arrow bail-outs are both ultimately "the mask would copy the
  wrong pixels", which stops being a problem once nothing is copied. Weigh that
  before spending effort hardening either against a mechanism this would
  replace.
- **Semi-transparent and hachure-filled elements composite against the scene
  background, not the embeddable.** The copied pixels are Excalidraw's already
  composited output, so a 50%-opacity element over an embeddable shows itself
  blended with the view background rather than with the video underneath, and a
  hachure fill's gaps show background rather than embed content.
