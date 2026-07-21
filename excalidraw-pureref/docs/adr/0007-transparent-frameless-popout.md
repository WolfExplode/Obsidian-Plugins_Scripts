---
status: proposed
---

# Proposed transparent, frameless Popout via a window-open handler

PureRef's defining visual effect is a genuinely see-through surface around the reference images. A main-process `setWindowOpenHandler` was proposed as a way to request `transparent: true` and `frame: false` when Obsidian creates a Popout through `window.open`.

The proposal is **not accepted and is not implemented in the checked-in code**. The recovered experiment produced a frameless-looking but opaque Obsidian Popout, even though directly constructed transparent windows worked on the same machine. The cause remains unknown; see `docs/transparent-popout-investigation.md` for observations, failed experiments, hypotheses, and untried alternatives.

If a future experiment validates this route, accepting it would require revisiting ADR 0003. Until then, ADR 0003 remains the current baseline and this document records only a proposed direction.
