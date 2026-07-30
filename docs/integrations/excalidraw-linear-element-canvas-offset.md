# Excalidraw linear-element canvas offset

## Scope

Known upstream Excalidraw core bug, present in the `@zsviczian/excalidraw`
0.18.112 fork bundled with obsidian-excalidraw-plugin 2.25.3. Documented here so
it isn't rediscovered as a plugin bug: it looks exactly like "our geometry is
wrong", and it is not. This plugin compensates for it in one place only — the
front-of-embed mask (`maskPlacement` in `src/front-of-embed.ts`).

Affects `line`, `arrow`, and `freedraw` elements. Shapes, text and images go
through a different path in the same function and are unaffected.

## Symptom

Excalidraw paints the element a little below and/or to the right of the geometry
it generates for it — the same geometry its own `exportToSvg` and
`exportToCanvas` emit. Typically one to two scene units, but it moves with the
element's `seed`, and it is constant in *scene* units (measured identical at zoom
1, 2 and 4), so at high zoom it is several pixels.

Nothing in Excalidraw's own UI makes this obvious: the selection outline is drawn
from the same `x1`/`y1` the blit uses, so the box still hugs the drawn stroke.
It only shows when something outside Excalidraw has to land on the drawn pixels —
here, an alpha mask built from the element's real geometry, which ended up
straddling the stroke.

## Root cause

`packages/element/src/renderElement.ts`. `generateElementCanvas` renders the
element into a per-element canvas, offsetting it by the gap between the element's
origin and its bounds:

```js
const [x1, y1] = getElementAbsoluteCoords(element, elementsMap);
canvasOffsetX = element.x > x1 ? distance(element.x, x1) * window.devicePixelRatio * scale : 0;
canvasOffsetY = element.y > y1 ? distance(element.y, y1) * window.devicePixelRatio * scale : 0;
context.translate(canvasOffsetX, canvasOffsetY);
```

`drawElementFromCanvas` then blits that canvas so its `padding` pixel lands on
scene `(x1, y1)`:

```js
context.drawImage(elementWithCanvas.canvas,
  (x1 + appState.scrollX) * window.devicePixelRatio - padding * ...,
  (y1 + appState.scrollY) * window.devicePixelRatio - padding * ..., ...);
```

Put together, element-local `(0, 0)` lands on scene `x1 + max(0, element.x - x1)`.
When the drawn geometry reaches up and left past the element's origin —
`element.x >= x1`, the usual case — that resolves to `element.x` and everything
is correct. When the geometry starts *after* the origin (`element.x < x1`), the
`element.x > x1` guard clamps the offset to 0 and the element is painted
`x1 - element.x` too far right. Same independently on y.

For a linear element `x`/`y` is where the first point went down, and `x1`/`y1`
are the bounds of the **drawn curve** including rough.js's hand-drawn jitter — so
the two disagree exactly when the jitter keeps the whole stroke below or right of
its own first point.

## When it actually bites

That needs a stroke that never wanders back past its first point, which in
practice means **dashed or dotted at cartoonist roughness**:

- Below cartoonist, `generateRoughOptions` sets `preserveVertices: true`
  (`continuousPath || element.roughness < ROUGHNESS.cartoonist`), which pins the
  endpoints to the recorded points, so the bounds start at the origin.
- A solid stroke is drawn as two rough.js passes (`disableMultiStroke` is only
  set for non-solid strokes), and one of the two nearly always reaches past the
  origin.
- A non-solid cartoonist stroke is a single unpinned pass, and can miss entirely.

## Evidence (2026-07-30, live board)

Dashed, cartoonist, curved `line`, `strokeWidth` 4:

| measurement | result |
| --- | --- |
| `exportToSvg` path vs `exportToCanvas` render, best alignment | IoU 0.97 — the two renderers agree |
| live canvas ink vs that geometry | drawn 1.25–1.41 scene units low |
| same element, `strokeStyle: "solid"` | −0.11 units — no offset |
| same element, roughness 0 or 1, dashed | within noise (±0.4) |
| same element, seeds 1146008870 / 12345 / 999 / 777777 | +1.12 / −0.35 / +0.62 / +1.92 units |
| same element at zoom 1 / 2 / 4 | +1.25 units at all three (so not pixel rounding) |
| `getCommonBounds([element])` minus `element.y` | +1.41 — matches the drawn offset |

## How this plugin handles it

`maskPlacement` (`src/front-of-embed.ts`) reproduces the displacement rather
than correcting it: the mask's job is to land on the pixels Excalidraw drew, not
the ones it should have drawn.

```
shift = type is line/arrow/freedraw ? max(0, boundsMin - elementOrigin) : 0
```

The bounds come from `ExcalidrawLib.getCommonBounds([element])` in the view
layer — they are the drawn-curve bounds, which nothing outside Excalidraw can
compute. That call is rotation-aware where the canvas placement is not, so a
rotated element is measured through an unrotated copy. The same bounds give the
rotation pivot, which `drawElementFromCanvas` takes as their centre.

If the bug is ever fixed upstream, `maskPlacement`'s shift silently becomes 0
for the fixed cases only if Excalidraw also changes what its bounds report;
otherwise the shift must be removed at the same time. It is one branch, gated on
`CANVAS_OFFSET_TYPES`, with unit tests in `tests/front-of-embed.test.ts`.

## Upstream status

Not filed. A search of excalidraw/excalidraw issues on 2026-07-30 turned up
nothing matching (nearest neighbours are unrelated linear-element bugs:
[#9292](https://github.com/excalidraw/excalidraw/issues/9292),
[#9755](https://github.com/excalidraw/excalidraw/issues/9755)). Worth reporting
upstream if anyone wants to: the guard should be a signed offset rather than a
clamp, since `distance()` is already unsigned and the clamped branch is exactly
the broken one.

## See also

- [Front-of-embed rendering](../behavior/front-of-embed-rendering.md) — the
  feature that surfaced this, and where the compensation lives.
- [ADR 0010](../adr/0010-front-of-embed-rendering.md) — why the mask reproduces
  Excalidraw's placement instead of the "correct" one.
- [Excalidraw embeddable z-order limitation](excalidraw-embeddable-z-order-limitation.md)
  — the upstream limitation that made front-of-embed rendering necessary at all.
