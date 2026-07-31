# Excalidraw embeddable z-order limitation

## Scope

Known upstream Excalidraw core limitation. No fix is shipped by this plugin.
Documented here so it isn't repeatedly rediscovered or mistaken for an
Obsidian-layer or plugin bug. Applies to every `embeddable` element — local
video/pdf/markdown embeds, animated-image embeddables (see
[Obsidian Canvas image-embed stretch fix](obsidian-canvas-image-stretch-fix.md)),
and web embeds (YouTube, generic iframes) alike.

## Symptom

An embeddable (e.g. an `.mp4`) always renders visually on top of ordinary
canvas-drawn elements (rectangles, images, freedraw, text, ...), no matter
what "Send to back" / "Bring to front" is used on either element. Two or more
embeddables *do* respect z-order relative to each other; the limitation is
only between the embeddable layer and the canvas layer.

## Root cause

Traced in Excalidraw core, `packages/excalidraw/components/App.tsx`:

- All non-embeddable elements are painted into a single `<canvas>` (the
  static + interactive canvas layers), in scene z-order, as one bitmap.
- Embeddables are not drawn into that canvas at all. `renderEmbeddables()`
  ([App.tsx:1740](../../reference/excalidraw-master/packages/excalidraw/components/App.tsx#L1740))
  renders each embeddable as its own DOM node (an `<iframe>`/`<webview>`, or
  in this plugin's Obsidian integration, a mounted `WorkspaceLeaf`/Canvas
  node — see [CustomEmbeddable.tsx](../../reference/obsidian-excalidraw-plugin-master/src/view/components/CustomEmbeddable.tsx)).
  That call happens *after* the canvas layers in the JSX tree
  ([App.tsx:2600-2655](../../reference/excalidraw-master/packages/excalidraw/components/App.tsx#L2600-L2655)),
  so in normal DOM stacking order every embeddable's DOM node sits above the
  entire canvas bitmap, unconditionally.
- Within `renderEmbeddables()` itself, embeddables are mapped in scene order,
  so z-order *is* respected between embeddables — the break is only ever
  "embeddable vs. canvas-drawn element."

Verified live against a running board (2026-07-29), the layering inside
`.excalidraw` is:

| layer | z-index | pointer-events |
| --- | --- | --- |
| `canvas.static` (all drawn elements) | 1 | none |
| `canvas.interactive` (selection UI) | 2 | auto |
| `.excalidraw__embeddable-container` | 2, later in DOM → paints above | none until active |
| `SVGLayer` / wysiwyg text editor | 3 | — |

So the embeddable layer beats the drawn layer by exactly one z-index step plus
DOM order. That is what makes a plugin-owned overlay viable at all (see below),
and also why the tempting fix — pushing the embeddable *below* the static canvas
with CSS — does not work: the static canvas is filled opaque with
`viewBackgroundColor`, so a demoted embeddable is hidden rather than revealed.

"Bring to front" / "Send to back" changes each element's position in the
scene's z-order array, which correctly reorders paint order within a layer
(canvas-drawn elements among themselves, or embeddables among themselves). It
cannot move an element across layers, so it can never put a canvas-drawn
element in front of an embeddable.

## Upstream status

Confirmed, open, unresolved as of 2026-07-26, against Excalidraw core:

- [Web embeds are always on top of all other drawing elements · Issue #9431](https://github.com/excalidraw/excalidraw/issues/9431) — exact match for this symptom, filed against Excalidraw core.
- [\[TODO\] z-index support · Issue #21](https://github.com/excalidraw/excalidraw/issues/21) — the original, years-old request for general z-index controls.

Users have also hit this against `obsidian-excalidraw-plugin` itself, and the
maintainer's responses there confirm it's the same upstream limitation rather
than anything Obsidian-specific:

- [FR: Allow drawing on top of embedded files · Issue #2089](https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/2089) —
  closed same-day, labelled `Can't fix` / `transfer to excalidraw.com`: "the
  root cause is outside this plugin."
- [BUG: ...canvas elements cannot be placed on the topmost layer · Issue #2628](https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/2628) —
  closed as not-a-bug: "a consequence of how interactive embeds are solved. If
  your objective is to draw on top of a markdown embed, embed it as an image
  not as an interactive embeddable" — i.e. the only workaround upstream
  offers is opting out of the interactive embeddable entirely, which is
  exactly the workflow this plugin's front-of-embed mechanism removes the
  need for.

## Why this plugin doesn't patch it

Unlike the [image-embed stretch fix](obsidian-canvas-image-stretch-fix.md),
which was a scoped CSS rule on Obsidian's own DOM, fixing this would mean
either an upstream Excalidraw architecture change (interleaving embeddable
DOM nodes with per-element canvas painting, which the single-bitmap
canvas-layer design doesn't support today) or this plugin monkeypatching
Excalidraw's own render pipeline (`renderEmbeddables` / canvas layering) —
materially riskier and more invasive than the input-layer patches in
[Excalidraw shortcut interception](excalidraw-shortcut-interception.md), and
liable to break on every Excalidraw version bump. Treated as an accepted
known limitation unless it starts actively blocking a specific workflow.

It started blocking one: see
[Front-of-embed rendering](../behavior/front-of-embed-rendering.md) and
[ADR 0010](../adr/0010-front-of-embed-rendering.md) for the plugin-owned
mechanism (a separate DOM overlay layer, not a patch to this pipeline) that
now works around it for the annotate-over-media workflow.
