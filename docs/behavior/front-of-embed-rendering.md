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
up to "The read-only transparent window" describes the editable surfaces; that
section covers the read-only window on its own terms. **The candidate set —
which elements render in front — is shared**, so a Board looks the same either
side of the F10 switch.

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
- **Sloppiness, stroke style and pen settings are honoured.** The paint follows
  the path Excalidraw actually drew, so architect, artist and cartoonist all
  render correctly, dashed and dotted strokes render as dashes and dots rather
  than as a solid line, and a stroke drawn with a custom pen keeps that pen's
  own profile.
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
  element. Each member is painted individually, so a group half over an
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
  placement — it paints as ordinary text. **Arrow labels are the exception** and
  bail out as a pair with their arrow; see the scope cuts below.
- **Only the element occludes the embeddable, not its bounding box.** An
  unfilled rectangle shows the embeddable through its interior; text occludes
  only its glyphs; a stroke occludes only its own width. A filled shape occludes
  its interior, as expected.
- **Selection needs nothing from this mechanism — it already works.** Clicking
  an element where it overlaps an embeddable selects that element, not the
  embeddable, and it stays draggable there. This looked like it would need a
  hit-test router (the overlay is `pointer-events: none`, and Excalidraw
  hit-tests on its interactive canvas *below* the embeddable's DOM node), but
  an inactive embeddable's container is itself `pointer-events: none`, so the
  click reaches the interactive canvas and Excalidraw hit-tests it in ordinary
  scene z-order — where the front element already wins. No pointer-event
  routing was needed.
- **The paint follows Excalidraw's own placement, quirks included.** Excalidraw
  paints a line, arrow or freedraw a little low and/or right of the geometry it
  generates for it, whenever the drawn stroke starts after the element's own
  `x`/`y` — an upstream bug, documented in full in
  [Excalidraw linear-element canvas offset](../integrations/excalidraw-linear-element-canvas-offset.md).
  It shows up on dashed and dotted **cartoonist** strokes clearly enough to
  visibly straddle the stroke. `elementPlacement` applies the same
  displacement, so the paint lands on the pixels Excalidraw actually drew.
- **A stroke's box is where the stroke is, not where it started.** Excalidraw
  pins a line/arrow/freedraw's `x`/`y` to its *first point*, so a scribble drawn
  right-to-left or bottom-to-top extends left and up from there. Both the
  overlap test and the rotation pivot go through `geometryOffset`
  (`pack-elements.ts`) for this — taking `x`/`y` as the top-left instead gave a
  box hanging off the starting point, which made a big scribble render in front
  only when the embeddable happened to sit inside that phantom box.
- **Nothing is persisted to the `.excalidraw` file.** Front-of-embed status is
  recomputed from ordinary element data (array order + bounding-box overlap)
  on load and after every relevant mutation — a file opened in vanilla
  Excalidraw or another tool looks and behaves the same as before.
- **Costs nothing when unused.** The compositing loop runs only while at least
  one element actually qualifies, and stops itself again when none do.

## Deliberate scope cuts

- **Frames bail out entirely.** A candidate with a `frameId` is skipped and
  stays behind the embeddable. A frame *clips* its children and this mechanism
  has no clip of its own, so painting a partly-clipped element would show scene
  background from wherever the frame cut it off. Embeddables inside a frame are
  likewise not treated as embeddables to be in front of. Groups are **not** a
  bail-out — see "Behavior" above.

  *Deferred, not blocked.* Reproducing the frame's clip is cheap on its own
  (`frameClip` is a translate + `roundRect` + `clip()`, and frames can't
  rotate), but three things make it more than an hour's work: knowing exactly
  *when* Excalidraw applies the clip (`shouldApplyFrameClip` has a fiddly half
  about group members and in-progress drags that isn't safe to skip), framed
  embeddables would need to start counting as embeddables to be in front of,
  and a frame's own border/label are chrome this mechanism never paints anyway.
- **Text and images have no emitted paths.** Excalidraw exports text as `<text>`
  and images as `<image>`, neither of which is path geometry, so neither can be
  drawn from emitted paths. They diverge from there: text is *drawn* as glyphs
  in the element's own colour, placed by Excalidraw's own `getVerticalOffset`
  maths, while an image is *blitted* through a box mask, since its pixels can
  only come from the canvas.
- **A candidate with no export yet is simply not painted, for that frame.** The
  emitted-geometry cache is asynchronous (see "How candidates are painted"
  below), so a freshly-drawn or just-resized element has nothing to draw from
  for a frame or two, and it stays behind the embeddable until its geometry
  arrives. An earlier reconstruction fallback (rough.js/perfect-freehand ports
  in `rough.ts`/`freehand.ts`) covered that gap but was later dropped — live
  testing found no visible flash or flicker without it, and the ports were
  reconstructions of code not in this plugin's bundle, liable to drift silently
  on an Excalidraw update.
- **Hachure and cross-hatch fills paint as solid.** `fillStyle` is read for
  whether a fill exists but a hatched interior still fills as a slab rather than
  as its lines, because the fill follows the emitted fill path rather than its
  hatching.
- **Bound, elbowed, and labelled arrows bail out.** Excalidraw does not draw
  these along their own `points` — a bound endpoint is pulled back to the bound
  element's boundary, and an elbowed arrow is re-routed as orthogonal segments —
  so their drawn path can't be reconstructed from element data. A *labelled*
  arrow bails out as a pair with its label, for the same reason on both halves:
  the label's own `x`/`y` are ignored in favour of
  `LinearElementEditor.getBoundTextElementPosition`, and `drawElementFromCanvas`
  punches a label-shaped hole in the arrow's own render. All of these stay
  behind the embeddable; an ordinary unbound, unlabelled arrow works normally.

  *Deferred as low-value.* Placing a labelled arrow's label correctly would be
  cheap (`getCommonBounds([arrow, label])` already resolves it through
  `getBoundTextElementPosition`), but reproducing the hole-punch means painting
  the pair as a fixed-order unit, which gives up the paint loop's
  one-element-at-a-time independence — and a labelled arrow is usually also a
  *bound* one, which bails out for the harder reason anyway. So the case this
  would unlock (a labelled, unbound, non-elbowed arrow crossing an embeddable)
  is narrow enough that it isn't worth the change.

## How candidates are painted

Each candidate is either **drawn** or **blitted**, and drawn is the good path:

- **Drawn** — the element's emitted paths, stroked and filled in the colours
  Excalidraw emitted them with, straight onto the transparent overlay. Text is
  drawn as glyphs in the element's own `strokeColor`, since Excalidraw exports
  `<text>` rather than path geometry. Nothing is copied, so no scene background
  can come with it, and the element composites onto the embed itself — which is
  what makes a semi-transparent annotation show the video through it.
- **Blitted** — paint an alpha mask of the element, then `source-in` a copy of
  Excalidraw's static canvas through it. Used only for **images**, whose pixels
  can't come from anywhere else — masked as their whole opaque box, so there's
  no antialiased edge to leave a rim. Nothing else is ever blitted: a non-image
  candidate with no export yet is skipped for that frame instead (see the scope
  cuts above), not blitted as an approximation.

The two share one paint, in that order: the blitted stencil is composited first,
then the drawn candidates go over the top with `source-over` — which keeps the
`source-in` from consuming anything but its own stencil.

**Dark theme has to be applied by hand on the drawn path.** Excalidraw implements
dark theme as `DARK_THEME_FILTER` (`invert(93%) hue-rotate(180deg)`), baked
into the canvas pixels rather than applied as CSS. So the blit inherits the
theme for free, but the drawn path must set `ctx.filter` itself — without it a
dark-theme board showed black text over the embed where Excalidraw had drawn
white. The filter is set for the drawn pass only; the blitted pixels have
already been through it.

**Where the geometry comes from.** The paint needs to know exactly where
Excalidraw drew each element, and it gets that from Excalidraw itself —
`exportToSvg` on a single element returns the real path data, which
`new Path2D(d)` parses directly, at element-local coordinates. Each path is
filled or stroked exactly as Excalidraw marked it, at the width and dash
pattern it marked, so no shape knowledge is involved on this plugin's side.
See `emitted-geometry.ts`.

This is asynchronous and there is no synchronous alternative (no `ExcalidrawLib`
export exposes per-element geometry synchronously, and Excalidraw's internal
`ShapeCache` is unreachable), so it is necessarily a cache:

- **The cache key is the element's geometry, not its `version`.** Moving,
  rotating and re-ordering leave it untouched, so no re-export happens; only
  drawing, resizing and **recolouring** invalidate it — colours are in the key
  because the emitted paths carry the colours they're painted in. `opacity` is
  deliberately not: the paint applies it live, so dragging the opacity slider
  re-exports nothing.
- **A cached path is only drawn if its signature still matches the element.**
  A resize therefore leaves the element unpainted for a frame rather than
  drawing its previous size or approximating the new one.

Exporting a single element costs well under a millisecond, with no perceptible
lag while drawing or resizing.

## The read-only transparent window

The read-only window (F10) has no Excalidraw canvas at all. It displays a static
SVG export of the Board, with live `<video>`/`<img>` overlays placed over the
regions local-media embeddables export to (see `board-render.ts`). So z-order
breaks there for two reasons that have nothing to do with the canvas one:
Excalidraw's SVG exporter renders iframe-like elements in a second pass after
every other element (`renderSceneToSvg`'s "render embeddables on top"), and
this plugin's own media overlays are appended after the SVG, so a playing video
covers the whole Board regardless.

**The mechanism: a second export, clipped.** The candidates
(`planFrontOfEmbedCandidates`, the same set the editable view uses) are
exported a second time into their own SVG —
`ea.copyViewElementsToEAforEditing(candidates, true)` followed by `createSVG()`
with no template path — and that layer is appended last inside `#viewport`,
above both the base SVG and every media overlay. Nothing is approximated: it is
Excalidraw's own renderer drawing the same elements at vector resolution.

- **It is clipped to the embeddables.** The base export already drew these
  elements, so an unclipped second copy would paint every one of them twice —
  invisible for an opaque element, but a semi-transparent one would composite
  against itself, and a candidate would cover any later element it overlaps
  away from the embeddable. Clipped, the two copies own disjoint regions. The
  clip rectangles are the same rotation-aware AABBs (`elementAABB`) the overlap
  test used to admit the candidate, so the clip can never be tighter than the
  test.
- **Positioned by its own bounding box.** Each export is normalized to its
  content's bounds and records no absolute position, so the layer ships the
  scene coordinate its local (0,0) maps to, exactly as the base SVG ships
  `minX`/`minY` (`ea.getBoundingBox` is the same bounds math the exporter
  uses).
- **Its ids are namespaced.** Both layers go into the same document, and an
  export names its masks and clip paths after the element ids they belong to —
  so the layers, which by design share elements, would collide on
  `userSpaceOnUse` mask ids that `url(#id)` resolves to the first match for.
- **Images come from the live view.** `copyViewElementsToEAforEditing`'s
  `copyImages` pulls each image candidate's binary out of the view's loaded
  scene files, which is why the layer is rendered while the editable Popout is
  still alive rather than from the file on disk.
- **Web embeds are covered too.** An absolutely-positioned sibling appended
  after the SVG paints above a live `<iframe>` inside a `foreignObject`, so
  annotations land in front of a YouTube embed as readily as in front of a
  video file.
- **It costs nothing on a Board with no candidates.** No candidates, no second
  export, no layer in the payload.

This is deliberately not the mask-and-blit mechanism ported (there is no canvas
to blit from), and deliberately not surgery on the single existing export
(moving embeddable nodes back to their z-order position) — that would need a
node→element mapping the export doesn't publish, re-derived from render-order
rules (mask siblings, frame double-nodes, link-wrapper `<a>` tags) that are
liable to break silently on an upstream change.

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
  embeddable, not one sliced in at each embeddable's actual depth. An element
  meant to sit in front of one embeddable but behind another (e.g. `Embed A
  (back) → Image X → Embed B (front)`) will incorrectly render above both.
  Accepted as a known limitation — the common case of a single embeddable with
  elements in front of it is unaffected. A `mask-image` hole-punch on the
  embeddable container (each embeddable carrying a mask built from only the
  elements above *it*) is the candidate fix, not yet built.
- **Semi-transparent and hachure-filled elements composite against the scene
  background, not the embeddable — for blitted candidates only (images).** A
  drawn element composites onto the overlay's transparent canvas and therefore
  onto the embed itself, so a 50%-opacity annotation shows the video through
  it, and a hachure fill's gaps show embed content. This only fails for images,
  whose pixels have to come from the opaque static canvas. Element opacity is
  applied live from `element.opacity` rather than baked into the export, so
  dragging the opacity slider re-exports nothing.

Earlier revisions of this mechanism masked-and-blitted every candidate from
Excalidraw's static canvas, which left a rim of scene background around thin
elements (worst at low zoom, where it could replace a stroke's colour outright
rather than just fringe it). Switching to drawing emitted paths directly
removed the rim entirely for every candidate except images, which still blit
because their pixels have nowhere else to come from. See
[ADR 0010](../adr/0010-front-of-embed-rendering.md) for that history.
