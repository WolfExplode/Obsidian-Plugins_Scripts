---
status: accepted
---

# PureRef-style hold-C drag crop, built on Excalidraw's native crop

## Decision

Holding **C** and dragging a rectangle over the Board crops images to that
rectangle, mirroring PureRef's crop gesture. If images are selected, all of them
are cropped; if nothing is selected, every image the rectangle covers is cropped.
It is bound per window and so works in the main window and every Popout.

The crop is driven entirely through Excalidraw's own `crop` element field — not a
bespoke image rewrite. The full source image is always retained, so Excalidraw's
native double-click (or `Enter`) still re-exposes the whole original, and the
change is a single undoable step.

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

**Rotated images are skipped.** A screen-aligned rectangle over a rotated image
is a rotated quad in image space, which an axis-aligned `crop` cannot represent.
Matching PureRef here would require rasterising the rotated pixels into a new
image file — destructive, and it would throw away the retained original that is
the whole point of using the native crop. So rotated images are left untouched
(reported in `CropResult.skipped`); the user can still crop them via Excalidraw's
own double-click crop editor. This may be revisited if cropping rotated
references turns out to be common.

**Natural pixel size.** `crop.{x,y,width,height}` must be true decoded pixels.
Already-cropped images carry the size in `crop.naturalWidth/Height` (free);
uncropped images are decoded once from `excalidrawAPI.getFiles()` to learn it,
which is why `cropImagesToSceneRect` is async.

## Architecture

The feature follows the established per-window attach pattern (see
`attachPackKeydown`), which is what lets the Popout inherit it for free:

- **`cropImagesToSceneRect(leaf, rect, ids?)`** in `excalidraw-view.ts` — the
  reusable primitive (scene-rectangle → native crop). `uncropImages` is its
  inverse. Both write through `updateScene` with a version bump, as one history
  entry, exactly like `resizeSceneElements`.
- **`attachCropDrag(win, app)`** in `crop-drag.ts` — the C-held marquee overlay
  that produces the dragged rectangle and calls the primitive. Registered on the
  main window in `main.ts` and on each Popout in `popout-manager.ts` alongside
  `attachPackKeys`, with a matching `detachCropDrag` disposer.
- **`window.__eprCropDebug`** — a live console hook (`crop`, `cropSelection`,
  `uncrop`, `info`) kept in the shipped build to drive the primitive without a
  pointer gesture across the main + Popout realms.

Per ADR 0001 none of this imports Excalidraw's source; it depends only on the
public runtime `excalidrawAPI` and the documented `crop` element field.
