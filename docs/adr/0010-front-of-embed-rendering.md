---
status: amended
---

# Front-of-embed rendering masks and blits Excalidraw's own canvas

> **Amended.** Candidates are now drawn (Excalidraw's own emitted paths, in
> Excalidraw's own colours) rather than masked-and-blitted from the static
> canvas; the blit survives only as the path for images, which have no path
> geometry to draw. An earlier reconstruction fallback for elements whose
> geometry hadn't loaded yet was also dropped once testing showed it wasn't
> needed — see "Amendments" at the end for both.

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

- A DOM `<canvas>` mounted as the last child of the `.excalidraw` root.
  Embeddable containers and the interactive canvas both sit at `z-index: 2`
  and the static canvas at `1`, so an overlay at `z-index: 2` appended after
  the embeddables wins on DOM order — while `--zIndex-svgLayer` and
  `--zIndex-wysiwyg` (both 3) correctly stay above it.
- Whenever a non-embeddable element's position in the scene array is already
  in front of an embeddable it overlaps (AABB overlap, same test as
  [overlap-aware-zorder.md](../behavior/overlap-aware-zorder.md)'s
  `elementAABB`), the overlay paints it: normally by stroking/filling
  Excalidraw's own emitted paths in Excalidraw's own colours, or — for images
  only — by masking the element's shape and copying Excalidraw's static canvas
  through it with `source-in`. See "Amendments" for how the balance between
  those two shifted.
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

Because the overlay recomposites from live element data rather than a
snapshot, a drag/resize/rotate/draw gesture needs no handling of its own: the
painted element moves because it *is* the element, redrawn. There is no cache
to invalidate for the drawn path beyond the geometry cache described below,
no in-flight export to supersede, and no gesture state.

### The read-only transparent window renders a second, clipped export instead

The mechanism above is about the editable surfaces. The read-only window
(ADR 0008) has no Excalidraw canvas to draw from or blit from: it shows a
static SVG export with live media laid over it, and z-order breaks there for
two separate reasons — Excalidraw's SVG exporter renders iframe-like elements
in a second pass after everything else, and this plugin's own media overlays
are appended after the SVG.

So that window gets its own mechanism: the same candidates
(`planFrontOfEmbedCandidates` — deliberately shared, so a Board looks the same
either side of the F10 switch) are **exported a second time into their own SVG
and appended above the media overlays, clipped to the embeddables**. The clip
is what keeps it from being a duplicate render rather than a re-ordering: each
copy owns a disjoint region, so no element is painted twice. `board-render.ts`
builds it through the same public ExcalidrawAutomate surface the base render
already uses (`copyViewElementsToEAforEditing` + `createSVG`), per ADR 0001.

Rejected there:

- **Reordering the single existing export** (moving each embeddable's nodes
  back to its z-order position, and injecting the media as a `foreignObject`
  at that depth). Strictly the better output — it would fix interleaved
  depths, which neither mechanism does — but it needs a node→element mapping
  the export doesn't publish (`data-id` is set only under `isTestEnv()`), and
  would have to re-derive upstream's render order (mask siblings, frame
  double-nodes, link-wrapper `<a>` tags), which is exactly the kind of thing
  that breaks silently on an Excalidraw version bump.
- **Re-exporting the whole Board minus the candidates as the base layer**,
  which would need no clip. Rejected to leave the base render alone: it goes
  through `createSVG(filePath)`, which loads the file and resolves embedded
  files itself, where an elements-only export can only see what the live view
  has already loaded.

## Rejected alternatives

- **Patching Excalidraw's `renderEmbeddables`/canvas pipeline directly** —
  already rejected in the integrations doc as materially riskier and liable
  to break on every Excalidraw version bump.
- **Demoting the embeddable below the static canvas with CSS** — the tempting
  one-liner, since the embeddable container is only one z-index above the static
  canvas. It cannot work: `bootstrapCanvas` fills the static canvas with
  `viewBackgroundColor` unless it is exactly `"transparent"`, so a demoted
  embeddable would be hidden behind an opaque background rather than revealed.
- **Re-rendering the candidate elements asynchronously via
  `ExcalidrawLib.exportToBlob`** — built first, then replaced. Every one of its
  problems traced to the export being asynchronous and therefore always behind
  the live scene: a bitmap/bounds pair that could desync (visible warping
  mid-drag), a cache to dedupe and supersede in-flight exports, gesture
  suppression to avoid ghosting, a separate embeddable-dimming subsystem for
  live feedback, PNG round-trip blur when zoomed in. Kept on the
  `backup/front-of-embed-rasterize` branch.
- **A separate always-on-top transparent overlay window** — this plugin
  already solves a structurally similar problem this way (transparent
  read-only Popout, [ADR 0008](0008-editable-and-transparent-modes-use-separate-windows.md)).
  Rejected here because that surface is read-only; the goal is live drawing
  in the same editable view, which a second window can't provide.

## Consequences / deliberate scope cuts

- **Correct geometry is not enough; the paint has to be placed the way
  Excalidraw places the element**, quirks and all. A linear or freedraw
  element is painted slightly off its own geometry whenever the drawn stroke
  starts after the element's origin — an upstream bug in
  `generateElementCanvas`/`drawElementFromCanvas`, traced in
  [Excalidraw linear-element canvas offset](../integrations/excalidraw-linear-element-canvas-offset.md).
  `elementPlacement` reproduces the displacement rather than trying to be
  "right" about it: the job is to land on the pixels Excalidraw drew, not the
  pixels it should have drawn. Same reason the rotation pivot comes from
  Excalidraw's bounds.
- **Framed elements bail out**; grouped elements and labelled shapes do not.
  The line is whether the element is drawn somewhere this mechanism can't
  follow. A frame *clips* its children and this mechanism has no clip of its
  own, so a partly-clipped element would show background from where the frame
  cut it off. Grouping, by contrast, changes nothing about how or where a
  member is drawn — and the group bail-out in `overlap-aware-zorder.md` is not
  precedent here, because that feature **reorders** elements (where upstream's
  group rules are non-trivial) while this one only reads the order that
  already exists. Similarly a shape's bound label is kept in absolute scene
  coordinates by `redrawTextBoundingBox`, so it paints as ordinary text; it
  rides on its container's verdict so the pair always crosses the embeddable
  together.
- **Bound, elbowed, and labelled arrows bail out**, one step further along the
  same reasoning: their `points` are not where Excalidraw draws them (a bound
  endpoint is pulled back to the bound element's boundary; an elbowed arrow is
  re-routed orthogonally), so geometry built from the points doesn't match
  what's on screen. An arrow *label* is the same problem twice: it is placed
  by `LinearElementEditor.getBoundTextElementPosition` rather than at its own
  `x`/`y`, and Excalidraw punches a label-shaped hole in the arrow's own
  render, which a naive stroke paint would fill in wrong.

  Both bail-outs are **deferred, not judged impossible** — the findings (what
  it would take, and why frames are the better-value half) are recorded under
  "Deliberate scope cuts" in
  [front-of-embed-rendering.md](../behavior/front-of-embed-rendering.md)
  rather than being re-derived here.
- A board with multiple embeddables at interleaved depths (e.g. an element
  meant to sit in front of one embeddable but behind another) is not
  correctly represented — the overlay is a single flat layer above every
  embeddable, not multiple depth-sliced layers. Accepted as a known
  limitation, not solved here.
- Selection was expected to need a hit-test router — an element only visually
  in front would still hit the embeddable underneath — and does not. An
  inactive embeddable's container is itself `pointer-events: none`, so a click
  passes through it to the interactive canvas, where Excalidraw hit-tests in
  scene z-order and the front element already wins. The overlay is
  `pointer-events: none` too and stays out of it entirely. No routing was
  written and none is planned.
- Because blitted pixels are Excalidraw's *composited* output, anything the
  scene already painted underneath a blitted candidate — the view background,
  or an element sitting behind the embeddable — is copied along with it
  wherever the mask covers. This was visible as a rim around thin elements
  under the original mask-and-blit design; drawing emitted paths instead
  removed it for every candidate except images. See "Amendments" below and
  "Known limitations" in the behavior doc.

## Amendments

**Drawing the emitted paths, instead of masking and blitting, is now the
normal path.** The blit's rim (background copied in a fringe around a masked
element) turned out to have no floor at low zoom — once an element's drawn
width fell below a screen pixel, the mask grew wider than the element and the
blit copied mostly board background, replacing a stroke's colour rather than
just fringing it. The fix was already latent: once mask geometry came from
`exportToSvg`, that export was also carrying each path's stroke/fill/width/dash
— painting those paths *as themselves* instead of using them only as a stencil
removes the copy, and with it the rim. Blitting now happens only for images,
whose pixels can't come from anywhere but the canvas. This is a different
thing from the rejected `exportToBlob` alternative above: emitted paths are
element-local vector data drawn synchronously under the live transform, not an
async raster snapshot, so none of that alternative's desync/caching/ghosting
problems apply. One real cost: dark-theme is baked into the static canvas as
pixels, so the blit gets it for free but the drawn path has to apply
Excalidraw's `DARK_THEME_FILTER` itself.

**The reconstruction fallback (`rough.ts`/`freehand.ts`, ports of rough.js and
perfect-freehand) was dropped.** It existed to cover a candidate for the frame
or two before its `exportToSvg` geometry landed. Once drawing emitted paths
became the normal path, live testing showed that gap didn't need covering — no
visible flash or flicker during a freedraw stroke, a resize, or a recolour
without it — so a candidate with no matching cached export is now simply
skipped for that frame instead. This also removed the one thing keeping the
ports load-bearing: they were validated against `exportToSvg` output rather
than upstream source, so they could have drifted silently on an Excalidraw
version bump. `MaskShape`/`maskShapeFor` (dilation, dash tables, corner radii,
diamond vertices, loop detection) collapsed to `PaintPlan`, a three-case
`"emitted" | "text" | "image"`, and `maskPlacement` was renamed
`elementPlacement` now that only images are masked.
