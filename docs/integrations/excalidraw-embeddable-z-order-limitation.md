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

"Bring to front" / "Send to back" changes each element's position in the
scene's z-order array, which correctly reorders paint order within a layer
(canvas-drawn elements among themselves, or embeddables among themselves). It
cannot move an element across layers, so it can never put a canvas-drawn
element in front of an embeddable.

## Upstream status

Confirmed, open, unresolved as of 2026-07-26:

- [Web embeds are always on top of all other drawing elements · Issue #9431](https://github.com/excalidraw/excalidraw/issues/9431) — exact match for this symptom, filed against Excalidraw core.
- [\[TODO\] z-index support · Issue #21](https://github.com/excalidraw/excalidraw/issues/21) — the original, years-old request for general z-index controls.

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
