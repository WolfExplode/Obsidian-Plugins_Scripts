---
status: accepted
---

# Front-of-embed rendering dims and rasterizes instead of patching Excalidraw's render pipeline

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

- A DOM `<canvas>` mounted after Excalidraw's embeddable nodes in the DOM, so
  plain DOM stacking order puts it above every embeddable, in both the main
  view and the editable Popout.
- Whenever a non-embeddable element's position in the scene array is already
  in front of an embeddable it overlaps (AABB overlap, same test as
  [overlap-aware-zorder.md](../behavior/overlap-aware-zorder.md)'s
  `elementAABB`), that element is rasterized onto the overlay canvas and kept
  aligned to the live viewport. Per ADR 0001, this plugin never imports
  Excalidraw's npm package directly — it only reads the runtime surface the
  Excalidraw plugin already exposes in that window. There is no
  `exportToCanvas` or `onScrollChange` on that surface (confirmed against
  `excalidrawLib.d.ts` and the `excalidrawAPI` shape this codebase already
  types in `excalidraw-view.ts`); the actual primitives available are
  `window.ExcalidrawLib.exportToBlob`/`exportToSvg` (async — decode the
  result into an `Image`/`ImageBitmap` and draw that onto the overlay canvas)
  for rasterizing. Viewport sync is a `requestAnimationFrame` loop (only running
  while the overlay has something to draw) that re-reads
  `excalidrawAPI.getAppState()` (`scrollX`/`scrollY`/`zoom.value`) each frame
  and redraws only when those values actually changed — deliberately chosen
  over subscribing to `onScrollChange` (which the upstream imperative API
  exposes, but which isn't yet confirmed present on the specific bundled fork
  this integration reads from) so viewport sync has no dependency on an
  unverified surface. This recomputes on every relevant scene mutation
  (z-order change, gesture end) — nothing is persisted to the `.excalidraw`
  file; v1 is purely derived from existing element data. Caching a computed
  flag for performance is an explicit option to revisit later, not ruled out.
- While a draw/drag/resize/rotate gesture is live on an element overlapping an
  embeddable, the embeddable's own DOM node (targeted by its
  `#embed-${element.id}` selector) is temporarily dimmed to a fixed opacity
  instead of trying to mirror the in-progress gesture on the overlay — the
  user sees Excalidraw's real, live rendering through the translucency. Full
  opacity is restored only after the post-gesture rasterize onto the overlay
  completes, avoiding a flash where the just-finished element briefly
  disappears.
- Front-of-embed rendering applies uniformly to every embeddable type and
  every non-embeddable element type; there is no per-type scoping and no
  settings toggle in v1.

## Rejected alternatives

- **Patching Excalidraw's `renderEmbeddables`/canvas pipeline directly** —
  already rejected in the integrations doc as materially riskier and liable
  to break on every Excalidraw version bump.
- **A separate always-on-top transparent overlay window** — this plugin
  already solves a structurally similar problem this way (transparent
  read-only Popout, [ADR 0008](0008-editable-and-transparent-modes-use-separate-windows.md)).
  Rejected here because that surface is read-only; the goal is live drawing
  in the same editable view, which a second window can't provide.

## Consequences / deliberate scope cuts

- Grouped elements, framed elements, and bound-text/container pairs bail out
  entirely (same precedent as `overlap-aware-zorder.md`) — they're left
  behind the embeddable as today rather than reimplementing group/frame
  z-order rules for this feature too.
- A board with multiple embeddables at interleaved depths (e.g. an element
  meant to sit in front of one embeddable but behind another) is not
  correctly represented — the overlay is a single flat layer above every
  embeddable, not multiple depth-sliced layers. Accepted as a known
  limitation, not solved here.
- An element that's only visually in front via the overlay still hits the
  embeddable underneath for clicks/selection — there is no pointer-event
  routing yet to redirect a click aimed at overlay content back to the real
  element. Accepted as a known limitation; a later pass may add a hit-test
  router if it becomes a real workflow blocker.
