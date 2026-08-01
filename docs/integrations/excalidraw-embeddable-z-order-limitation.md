# Excalidraw embeddable z-order limitation

## Scope

Excalidraw renders every embeddable above canvas-drawn elements regardless of
scene z-order. Embeddables still respect z-order relative to other embeddables.

## Cause

Non-embeddable elements are painted into shared canvas layers. Embeddables are
separate DOM nodes emitted by `renderEmbeddables()` after those canvases in
[`App.tsx`](../../reference/excalidraw-master/packages/excalidraw/components/App.tsx).
Scene array order can reorder elements within either rendering path, but cannot
interleave a DOM embeddable with individual pixels inside a shared canvas.

Moving the embeddable container below the static canvas with CSS is not a fix:
the static canvas has an opaque `viewBackgroundColor` and hides it.

Upstream tracking:

- [Web embeds are always on top of drawing elements](https://github.com/excalidraw/excalidraw/issues/9431)
- [General z-index support](https://github.com/excalidraw/excalidraw/issues/21)
- [Obsidian Excalidraw request #2089](https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/2089)

## Host-plugin behavior

The host plugin does not patch Excalidraw's renderer. Front-of-embed rendering
adds a clipped host-owned rendering pass for non-embeddable elements that scene
z-order places above an overlapping embed. See
[Front-of-embed rendering](../behavior/front-of-embed-rendering.md) and
[ADR 0010](../adr/0010-front-of-embed-rendering.md).
