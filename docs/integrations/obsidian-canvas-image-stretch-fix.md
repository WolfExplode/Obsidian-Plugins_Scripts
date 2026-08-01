# Obsidian Canvas image-embed stretch fix

## Scope

CSS-only fix, shipped in [styles.css](../../styles.css). Applies to any
Excalidraw `embeddable` element that links to a local `gif`/`webp`/`apng` file
(these are the animated-image extensions Excalidraw itself converts from a
static `image` element into an embeddable, and the only extensions Obsidian
maps to its native `"image"` view type).

## Symptom

Resize an Excalidraw board to make a video/pdf/markdown embeddable bigger and
its content stretches to fill the new box, as expected. Do the same to a gif
embeddable and the media stays pinned at its original pixel size in the
corner of the (now much larger) selection box, with dead space around it.

## Root cause

This is an upstream Obsidian bug, not a bug in this plugin or in the
[Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin).
Traced to `CustomEmbeddable.tsx`'s `RenderObsidianView` in that plugin's
source
(`reference/obsidian-excalidraw-plugin-master/src/view/components/CustomEmbeddable.tsx`):

- Embeddables whose linked file resolves to a view type in
  `CANVAS_VIEWTYPES` (`"markdown" | "bases" | "audio" | "video" | "pdf"`) are
  mounted through `canvasNodeFactory.createFileNote()` — Obsidian's own core
  **Canvas** plugin's file-node machinery, which is built to fill an
  arbitrary box (that's the entire point of a resizable canvas node). These
  all stretch correctly.
- A gif/webp/apng resolves to Obsidian's native `"image"` view type, which
  Canvas nodes handle no differently from the others — the node itself does
  get correctly sized to the Excalidraw element's box (confirmed live: the
  outer `.canvas-node`/`.excalidraw__embeddable__content` chain reports the
  full, correct pixel size). The break is one level deeper: inside that node,
  Obsidian's own native image-view renders the file into a `.image-container`
  div that shrink-wraps to the image's **intrinsic** natural pixel dimensions
  and is never told to fill its parent. `width`/`height` on the `<img>` alone
  can't fix this — 100% of a shrink-wrapped parent is still the shrink-wrapped
  size.

This matches a long-standing, still-open Obsidian core Canvas limitation,
reported independently of Excalidraw:
[Canvas: Images are not enlarged beyond their base resolution](https://forum.obsidian.md/t/canvas-images-are-not-enlarged-resized-beyond-their-base-resolution/112614),
[Canvas: Support upscaling/stretching of external images](https://forum.obsidian.md/t/canvas-support-upscaling-stretching-of-external-images/50149).
No upstream fix has shipped as of 2026-07-26.

## Fix

Two CSS rules in `styles.css`, scoped to `.canvas-node` so they only affect
Excalidraw's embeddable nodes and not Obsidian's normal note-embed image
rendering elsewhere:

```css
.canvas-node .image-container {
	width: 100% !important;
	height: 100% !important;
}
.canvas-node .image-container img {
	width: 100% !important;
	height: 100% !important;
	object-fit: cover !important;
	display: block !important;
}
```

Forcing `.image-container` itself to fill its parent closes the gap; the
`<img>` rule then stretches (with `object-fit: cover` to avoid distortion on
a mismatched aspect ratio) inside a container that's finally the right size.

## Verification

Confirmed live via the Obsidian DevTools MCP connection (injecting the CSS
into a running Obsidian, then screenshotting a resized gif embeddable)
before baking it into `styles.css`. To re-verify after any change here:
resize a board containing both a gif and a video embeddable side by side —
both should now stretch identically.
