# Excalidraw linear-element canvas offset

## Scope

Excalidraw can paint a line, arrow, or freedraw element slightly after its
exported geometry when the entire rough stroke lies right of or below its
recorded origin. This matters when host-plugin pixels must align with the live
canvas, especially front-of-embed rendering.

## Cause

In upstream `renderElement.ts`, `generateElementCanvas` offsets the per-element
canvas only when the element origin is greater than the drawn bounds origin:

```js
canvasOffsetX = element.x > x1 ? distance(element.x, x1) * scale : 0;
canvasOffsetY = element.y > y1 ? distance(element.y, y1) * scale : 0;
```

`drawElementFromCanvas` then places the canvas relative to `x1`/`y1`. When the
drawn bounds begin after the recorded origin, the zero-clamped offset displaces
the live paint by that gap. Dashed or dotted cartoonist strokes are most likely
to expose it because their single rough.js pass has unpinned vertices.

See the upstream implementations in
[`renderElement.ts`](../../reference/excalidraw-master/packages/element/src/renderElement.ts).

## Host-plugin contract

`elementPlacement` in `src/front-of-embed.ts` reproduces the live canvas
placement; its job is pixel alignment, not correcting upstream geometry:

```text
shift = linear-or-freedraw ? max(0, boundsMin - elementOrigin) : 0
```

The bounds come from `ExcalidrawLib.getCommonBounds` on an unrotated copy. They
also define the rotation pivot used by Excalidraw's canvas placement. If upstream
changes either placement or bounds semantics, update this compensation and its
tests together.

See also [Front-of-embed rendering](../behavior/front-of-embed-rendering.md) and
[ADR 0010](../adr/0010-front-of-embed-rendering.md).
