---
status: amended
---

# Use plugin-owned front-of-embed rendering

Excalidraw renders embeddables above canvas elements regardless of scene
z-order. That prevents a core workflow for this plugin: placing annotations or
reference elements in front of video, PDF, markdown, and web embeds. The
upstream constraint is documented in the
[embeddable z-order integration note](../integrations/excalidraw-embeddable-z-order-limitation.md).

## Decision

Implement front-of-embed rendering outside Excalidraw rather than patching its
render pipeline.

- One shared planner derives candidates from existing scene order and overlap.
  No data is added to the `.excalidraw` file.
- Editable Boards use a transparent DOM canvas above embeddables. It paints
  Excalidraw-emitted paths in their emitted styles, draws text, and blits images
  because their pixels exist only on Excalidraw's canvas.
- The read-only transparent window uses the same candidates in a second
  Excalidraw SVG export, clipped to the embeddable regions and placed above its
  media overlays.
- Integration stays on the public runtime surfaces exposed by the installed
  Excalidraw plugin, following ADR 0001.

The mechanism applies automatically on every supported surface. Existing
z-order commands determine the result; there is no separate user mode or
persisted setting.

## Consequences and limits

- Groups, bound and elbowed arrows, and labelled shapes or arrows are supported.
  Excalidraw's emitted geometry supplies the routed arrow shape; arrow-label
  placement is recomputed where stored label coordinates can be stale.
- Framed elements are excluded because reproducing Excalidraw's frame clipping
  rules is outside the current scope.
- Each surface uses one flat layer above all embeddables. Interleaved depths
  across multiple embeddables can therefore render incorrectly.
- Image candidates retain the compositing limitations of copying pixels from
  Excalidraw's opaque canvas. Vector and text candidates are drawn directly.
- The editable overlay runs only while candidates exist. The read-only layer is
  a snapshot, like the rest of that window.

Detailed eligibility, painting, label placement, and rendering limitations live
in [Front-of-embed rendering](../behavior/front-of-embed-rendering.md).

## Rejected alternatives

We reject a direct Excalidraw patch, CSS-demoting embeddables behind the opaque
static canvas, asynchronous whole-element raster exports, and a second overlay
window for editable interaction. These options either increase upstream drift,
hide the embed, lag live gestures, or lose editability.

## Amendment history

The first implementation masked and blitted every candidate. It was amended to
draw Excalidraw's emitted paths directly, leaving blitting only for images; this
removed background rims and raster lag. A hand-reconstructed rough.js/freehand
fallback was subsequently removed after live testing showed that briefly
skipping uncached geometry was preferable to maintaining a drift-prone renderer.
