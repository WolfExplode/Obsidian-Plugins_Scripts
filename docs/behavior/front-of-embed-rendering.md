# Front-of-embed rendering

## Scope

Applies to every non-embeddable element type (freedraw, arrow, line,
rectangle, ellipse, diamond, text, image) against every embeddable type (video,
PDF, markdown embed, web iframe), in the main Obsidian view, the editable
Popout, **and the read-only transparent window**. See
[ADR 0010](../adr/0010-front-of-embed-rendering.md) for why this is built as a
plugin-owned mechanism rather than a patch to Excalidraw's render pipeline, and
[excalidraw-embeddable-z-order-limitation.md](../integrations/excalidraw-embeddable-z-order-limitation.md)
for the upstream root cause this works around.

The editable surfaces and the read-only window reach the same result by
different means, because they are different kinds of surface: one is a live
canvas, the other a static SVG export with live media laid over it. Everything
up to "Where the mask geometry comes from" describes the editable surfaces; the
read-only window has its own section below. **The candidate set — which elements
render in front — is shared**, so a Board looks the same either side of the F10
switch.

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
  mechanism draws Excalidraw's own emitted paths in Excalidraw's own colours, so
  what shows over the embeddable is what Excalidraw drew — same colours, same
  hand-drawn stroke, crisp at any zoom. Images are the exception and are copied
  from Excalidraw's canvas instead; see "How candidates are painted".
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
- **Text and images have no emitted paths.** Excalidraw exports text as `<text>`
  and images as `<image>`, neither of which is path geometry, so neither can be
  drawn from emitted paths. They diverge from there: text is *drawn* as glyphs
  in the element's own colour, placed by Excalidraw's own `getVerticalOffset`
  maths, while an image is *blitted* through a box mask, since its pixels can
  only come from the canvas.
- **The reconstructed fallback is approximate where it is used.** For the frame
  or two before an element's geometry has been fetched, it is blitted through a
  mask from the ports, and a few of their cases are known to be imperfect: a
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

## How candidates are painted

Each candidate is either **drawn** or **blitted**, and drawn is the good path:

- **Drawn** — the element's emitted paths, stroked and filled in the colours
  Excalidraw emitted them with, straight onto the transparent overlay. Text is
  drawn as glyphs in the element's own `strokeColor`, since Excalidraw exports
  `<text>` rather than path geometry. Nothing is copied, so no scene background
  can come with it, and the element composites onto the embed itself — which is
  what makes a semi-transparent annotation show the video through it. No
  dilation is involved anywhere: that existed only to stop the blit clipping an
  antialiased edge, and an edge antialiasing against transparency needs no
  allowance.
- **Blitted** — the mask-and-blit path this mechanism started as: paint an alpha
  mask of the element, then `source-in` a copy of Excalidraw's static canvas
  through it. Now used only for **images**, whose pixels can't come from
  anywhere else, and for the frame or two before an element's export lands. An
  image is masked as its whole opaque box, so the rim the blit is prone to never
  applies to it.

The two share one paint, in that order: the blitted stencil is composited first,
then the drawn candidates go over the top with `source-over`. Splitting it that
way is what keeps the `source-in` from consuming anything but its own stencil.

**Dark theme has to be applied by hand on the drawn path.** Excalidraw implements
dark theme as `DARK_THEME_FILTER` (`invert(93%) hue-rotate(180deg)`) over
everything it draws, and it is **baked into the canvas pixels rather than applied
as CSS** — verified live (2026-07-31): nothing from the static canvas up to the
workspace leaf has a computed `filter`, yet `viewBackgroundColor` `#ffffff` reads
back as `18,18,18` and a `#1e1e1e` glyph as `211,211,211`, exactly `invert(93%)`
of each. So the blit inherits the theme for free and the drawn path must set
`ctx.filter` itself; without it a dark-theme board showed **black text over the
embed where Excalidraw had drawn white**. The filter is set for pass 2 only —
pass 1's pixels have already been through it, and filtering them twice would
undo it. Confirmed after the fix: drawn glyphs read `211,211,211`, byte-identical
to the static canvas.

The rest of this section is about where the geometry itself comes from — which
both paths need, one to draw and one to mask.

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
  rotating and re-ordering leave it untouched, so no re-export happens; only
  drawing, resizing and **recolouring** invalidate it. This matters because a
  scene change fires on every pointer move of a drag — where a recolour fires
  once, on commit. Colours are in the key because the emitted paths now carry
  the colours they are painted in. `opacity` deliberately is not: the paint
  applies it live from the element, so dragging the opacity slider re-exports
  nothing.
- **A cached path is only drawn if its signature still matches the element.** A
  resize therefore falls back to the blit for a frame rather than drawing the
  element's previous size.

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

## The read-only transparent window

The read-only window (F10) has no Excalidraw canvas at all. It displays a static
SVG export of the Board, with live `<video>`/`<img>` overlays placed over the
regions local-media embeddables export to (see `board-render.ts`). So z-order
breaks there for two reasons that have nothing to do with the canvas one:

- Excalidraw's SVG exporter renders iframe-like elements in a **second pass
  after every other element** — `renderSceneToSvg`'s "render embeddables on top"
  ([staticSvgScene.ts:780](../../reference/excalidraw-master/packages/excalidraw/renderer/staticSvgScene.ts#L780)).
  Confirmed live on the export the read-only window actually receives
  (2026-07-30): both embeddables came back as the last two children of the
  `<svg>`, in scene order, whatever their z-order.
- This plugin's own media overlays are appended after the SVG, so a playing
  video covers the whole Board regardless.

**The mechanism: a second export, clipped.** The candidates
(`planFrontOfEmbedCandidates`, the same set the editable view masks) are
exported a second time into their own SVG —
`ea.copyViewElementsToEAforEditing(candidates, true)` followed by `createSVG()`
with no template path, which renders exactly the elements the instance holds —
and that layer is appended last inside `#viewport`, above both the base SVG and
every media overlay. Nothing is masked and nothing is approximated: it is
Excalidraw's own renderer drawing the same elements at vector resolution.

- **It is clipped to the embeddables.** The base export already drew these
  elements, so an unclipped second copy would paint every one of them twice —
  invisible for an opaque element, but a semi-transparent one would composite
  against itself, and a candidate would cover any later element that overlaps it
  away from the embeddable. Clipped, the two copies own disjoint regions: the
  front one over the embeddable, the base one everywhere else. The clip
  rectangles are the same rotation-aware AABBs (`elementAABB`) the overlap test
  used to admit the candidate, so the clip can never be tighter than the test.
- **Positioned by its own bounding box.** Each export is normalized to its
  content's bounds and records no absolute position, so the layer ships the scene
  coordinate its local (0,0) maps to, exactly as the base SVG ships `minX`/`minY`.
  `ea.getBoundingBox` is the same bounds math the exporter uses — verified live
  (2026-07-30): a rectangle at scene x 28520 in a subset whose box starts at
  25580 exported at `translate(2940 …)`.
- **Its ids are namespaced.** Both layers go into the same document, and an
  export names its masks and clip paths after the element ids they belong to — so
  the layers, which by design share elements, would collide. `url(#id)` resolves
  to the first match in document order and these masks are `userSpaceOnUse`, so
  the front layer's labelled arrow would have been masked by the base layer's
  copy of that mask, in the base layer's coordinates.
- **Images come from the live view.** `copyViewElementsToEAforEditing`'s
  `copyImages` pulls each image candidate's binary out of the view's loaded scene
  files, which is why the layer is rendered while the editable Popout is still
  alive rather than from the file on disk.
- **Web embeds are covered too.** An absolutely-positioned sibling appended after
  the SVG paints above a live `<iframe>` inside a `foreignObject` — verified live
  (2026-07-30), so annotations land in front of a YouTube embed as readily as in
  front of a video file.
- **It costs nothing on a Board with no candidates.** No candidates, no second
  export, no layer in the payload.

This is deliberately *not* the mask-and-blit mechanism ported: there is no canvas
to blit from. It is also deliberately not surgery on the single existing export
(moving the embeddable nodes back to their z-order position), which would need a
node→element mapping the export doesn't publish — `data-id` is set only under
`isTestEnv()` — and would have to be re-derived from render-order rules that are
genuinely intricate (masks emitted as siblings, frames emitting two nodes,
`<a>` wrappers swallowing an element's nodes when it has a link) and would break
silently on an upstream change.

**Two limitations of the editable mechanism don't apply here.** There is no rim
of scene background, because nothing is copied from an opaque canvas — the layer
is transparent everywhere the elements aren't. And a semi-transparent or
hachure-filled element composites against the *embed*, showing the video through
it, because its only copy over the embeddable is drawn over the media itself.

**What it inherits, and what is new:**

- Interleaved depths are wrong the same way (see "Known limitations"): the layer
  is one flat surface above every embeddable, and the clip is the union of them
  all.
- The shared candidate rules' bail-outs still earn their keep even though nothing
  is masked. A framed element re-exported without its frame would lose the
  frame's clip, and a bound or elbowed arrow re-exported without the element it
  binds to is re-routed by Excalidraw as it exports.
- A candidate stroke that crosses an embeddable's edge is drawn as two clipped
  halves that meet there, each antialiased against transparency, so the seam can
  read a hair light under magnification. Not dilated to hide it: overlapping the
  two copies instead is what the clip exists to prevent.
- The layer is a snapshot taken when read-only mode opens, like the rest of the
  read-only Board. Nothing in that window updates live.

## Known limitations

- **Multiple embeddables at interleaved depths aren't correctly represented** —
  on every surface. Each mechanism is a single flat layer rendered above *every*
  embeddable, not one sliced in at each embeddable's actual depth. An element meant to sit in
  front of one embeddable but behind another (e.g. `Embed A (back) → Image X
  → Embed B (front)`) will incorrectly render above both. Accepted as a known
  limitation — the common case of a single embeddable with elements in front
  of it is unaffected.
- **A rim of scene background is copied along with the element** — **fixed**
  (2026-07-30) by not copying. Kept here because the fix reshapes the rest of
  this section, and because the reasoning is easy to re-derive wrongly.

  Excalidraw's static canvas is fully opaque: it is the view background with the
  scene drawn onto it, so every mask pixel that wasn't exactly on the element
  blitted board background over the embed. Since the mask had to be grown past
  the element's geometry to keep the blit from clipping the antialiased edge,
  some rim was unavoidable *as long as the mechanism copied from an opaque
  source*. It measured 39.7% of the overlay's opaque pixels, then 13.6% after
  the mask geometry was corrected, then effectively zero at working zooms once
  `fbb3eab` took the geometry from Excalidraw's own emitted paths — but it
  survived at low zoom, where `MASK_ANTIALIAS_ALLOWANCE_PX / zoom` is a
  screen-space half-pixel around an element that is itself sub-pixel. A dotted
  cartoonist line at 29% zoom rendered as **black dots instead of orange ones**:
  not rimmed, replaced.

  The fix was to stop blitting. Candidates are now **drawn** — the emitted paths
  stroked and filled in the colours Excalidraw emitted them with, text as glyphs
  in the element's own `strokeColor` — so nothing is copied and there is no
  background to deposit. Dilation is gone with it: it only ever existed to cover
  the blit's seam, and an edge antialiasing against transparency needs no
  allowance. See "How candidates are painted" below.

  Measured over the embeddable's rect on the same board, before and after:

  | zoom | before (opaque / alpha-weighted) | after |
  | ---: | ---: | ---: |
  |   5% | 19.0% / 28.3% | 0% / 0.4% |
  |  15% |  4.7% / 11.1% | 0% / 0% |
  |  29% |  ~0% /  ~5% | 0% / 0% |
  | 100% |    0% /  1.2% | 0% / 0% |

  The 0.4% residue at 5% is sub-threshold noise, not rim: below about alpha 32
  the colour read back from `getImageData` is wrecked by unpremultiply rounding
  (a 3%-alpha orange dot reads as pure `255,0,0`), so those pixels are counted
  as ink but not classified.

  **The `mask-image` hole-punch would not have fixed this** — worth recording,
  because it was written here as the candidate fix and is an easy idea to have
  again. Punching a hole in `.excalidraw__embeddable-container` reveals the
  static canvas underneath, which is the *same opaque pixels* the overlay was
  copying: view background plus element. Identical rim. What it would genuinely
  fix is the interleaved-depth limitation above, since each embeddable could
  carry a mask built only from the elements above *it*.
- **Semi-transparent and hachure-filled elements composite against the scene
  background, not the embeddable** — **fixed for drawn candidates** by the same
  change, and still true for blitted ones (images). A drawn element composites
  onto the overlay's transparent canvas and therefore onto the embed itself, so
  a 50%-opacity annotation now shows the video through it, and a hachure fill's
  gaps show embed content. Element opacity is applied live from `element.opacity`
  rather than being baked into the export, so dragging the opacity slider
  re-exports nothing.
