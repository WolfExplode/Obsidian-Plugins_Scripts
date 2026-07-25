---
status: accepted
---

# PureRef-style hold-C drag crop, built on Excalidraw's native crop

## Decision

Holding **C** and dragging a rectangle over the Board crops images to that
rectangle, mirroring PureRef's crop gesture. If images are selected, all of them
are cropped; if nothing is selected, the gesture is a no-op.
It is bound per window and so works in the main window and every Popout.

Upright images are driven through Excalidraw's own `crop` element field. Rotated
images require a generated viewport PNG because a screen-aligned polygon cannot
be represented by that axis-aligned field. In both cases the full source image
is retained, and the change is a single undoable step.

## Notable behaviours

**Crop only removes, never adds.** The drag rectangle is intersected with each
image's *current visible* box, not its full uncropped box. A rectangle that
reaches past an existing crop therefore shrinks the visible region at most — it
never re-adds pixels an earlier crop removed. Re-exposing hidden pixels is the
job of Excalidraw's double-click uncrop, which we deliberately do not duplicate
in the drag gesture. (`planImageCrop` clamps to `[el.x, el.y, el.width,
el.height]`; `uncropImages` is the separate, explicit inverse.)

**The gesture is screen-aligned; Excalidraw's `crop` is image-space.** The
rectangle the user drags is axis-aligned to the screen. Excalidraw's `crop`
stores an axis-aligned rectangle in the *source image's* natural-pixel space
(pre-rotation, pre-flip) — the renderer draws `crop.{x,y,width,height}` of the
decoded bitmap onto the element's box (`renderElement.ts` `drawImage`). For an
**upright** image the two frames coincide, so the crop is exact. **Flips**
(`scale === -1`) are exact too: the crop origin is stored from the opposite edge
(`nw - width - x`), matching Excalidraw's `adjustCropPosition`.

**Rotated images use a composed viewport crop.** A screen-aligned rectangle over
a rotated image is a rotated polygon in image space, which an axis-aligned
native `crop` cannot represent. The plugin therefore stores the original source,
the native crop that existed before the custom layer, an affine source-to-local
transform, and the accumulated visible polygon in `customData`. It materialises
that state as one canvas-rendered PNG-backed Excalidraw image. Subsequent
rotations move the polygon with the image; subsequent crops intersect the
existing polygon with a new rectangle and render again from the original source,
so repeated operations can produce multi-sided results without stacking or
accumulating raster generations.

The generated PNG is saved beside the source image as a named vault
attachment. Its path is stored in the element's custom metadata. Re-cropping
switches to the replacement and then removes the previous generated attachment;
exiting the custom crop first restores the original/native image and only then
removes the generated attachment. Cleanup waits until the live scene no longer
references the generated file ID, avoiding a renderer-versus-deletion race.

Alt+double-click on a custom-cropped image removes the custom layer and
restores the underlying native-cropped image, matching Excalidraw's uncrop
gesture. A plain double-click reaches Excalidraw's normal crop editor. Native
crop entry through Enter is blocked while the custom layer is active so the
generated PNG is never edited directly through that shortcut.

The generated-image registration and cleanup contract is shared infrastructure,
not a crop-specific decision. See the [Obsidian–Excalidraw generated-image
lifecycle](../integrations/obsidian-excalidraw-generated-images.md) before
changing it.

**Natural pixel size.** `crop.{x,y,width,height}` must be true decoded pixels.
Already-cropped images carry the size in `crop.naturalWidth/Height` (free);
uncropped images are decoded once from `excalidrawAPI.getFiles()` to learn it,
which is why `cropImagesToSceneRect` is async.

## Architecture

The feature follows the established per-window attach pattern (see
`attachPackKeydown`), which is what lets the Popout inherit it for free:

- **`cropImagesToSceneRect(app, leaf, rect, ids?)`** in `excalidraw-view.ts` — the
  reusable primitive (scene-rectangle → native crop or composed viewport crop).
  `uncropImages` removes the custom layer first, then handles native crop state.
  Both write through `updateScene` with a version bump, as one history entry,
  exactly like `resizeSceneElements`.
- **`attachCropDrag(win, app)`** in `crop-drag.ts` — the C-held marquee overlay
  that produces the dragged rectangle and calls the primitive. Registered on the
  main window in `main.ts` and on each Popout in `popout-manager.ts` alongside
  `attachPackKeys`, with a matching `detachCropDrag` disposer.
- **`window.__eprCropDebug`** — a live console hook (`crop`, `cropSelection`,
  `uncrop`, `info`) kept in the shipped build to drive the primitive without a
  pointer gesture across the main + Popout realms.

Per ADR 0001 none of this imports Excalidraw's source; it depends only on the
public runtime `excalidrawAPI` and the documented `crop` element field.
