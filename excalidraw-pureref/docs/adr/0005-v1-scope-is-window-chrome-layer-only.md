---
status: accepted
---

# v1 scope is the window/chrome layer only — no new Excalidraw canvas features yet

The original goal was to recreate "all features of PureRef." In practice, v1 is scoped to the Popout/always-on-top/chrome-hiding/F11-lifecycle layer around vanilla Excalidraw, using whatever image manipulation (move/resize/rotate/opacity/grouping) Excalidraw already provides as-is. PureRef-specific interaction niceties Excalidraw lacks (scroll-wheel opacity, outline toggle, quick grayscale, lightweight crop) are an intentional, acknowledged gap for v1.

This boundary is deliberate: reaching into Excalidraw's own element/interaction model to add new canvas features would reopen ADR 0001's "fork vs. depend on" trade-off in a much harder form, since window-chrome tricks operate from outside Excalidraw while new canvas behavior requires touching its rendering internals. New Excalidraw canvas features are an explicit, intended future phase — not rejected, just sequenced after the window/chrome layer is solid.

PureRef interchange (import/export of `.pur` files, per the CONTEXT.md glossary entry) is explicitly **in** v1 scope despite being orthogonal to the window/chrome layer — it doesn't touch Excalidraw's rendering internals (it's a file-format conversion built on the reverse-engineered `purformat` reference code), so it doesn't carry the same risk as new canvas features and was kept in v1 by deliberate choice.
