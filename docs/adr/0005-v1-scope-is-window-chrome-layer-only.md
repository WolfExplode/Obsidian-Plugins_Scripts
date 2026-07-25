---
status: superseded
---

# Historical v1 scope: stabilize the window and chrome layer first

The original stabilization phase scoped work to the Popout, always-on-top, chrome-hiding, and F11 lifecycle around vanilla Excalidraw. PureRef-specific interactions such as scroll-wheel opacity, outline toggles, quick grayscale, and lightweight crop were deliberately postponed while that lifecycle was still experimental.

That sequencing decision has served its purpose: the product is now functional and shippable. It no longer constrains the roadmap. New Board features may extend Excalidraw behavior when their product value justifies the maintenance cost, following ADR 0001's upstream-first strategy and its narrow patch or fork escape hatch for proven blockers.

PureRef interchange was included during the stabilization phase because it did not depend on Excalidraw's interaction internals. Its supported format remains governed separately by ADR 0006.
