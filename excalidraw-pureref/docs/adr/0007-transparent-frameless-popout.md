---
status: proposed
---

# Proposed transparent, frameless Popout via a window-open handler

PureRef's defining visual effect is a genuinely see-through surface around the reference images. A main-process `setWindowOpenHandler` was proposed as a way to request `transparent: true` and `frame: false` when Obsidian creates a Popout through `window.open`.

The proposal is **not accepted, and investigation is paused as of 2026-07-21**. The checked-in v10 F10 diagnostic is not product behavior. BrowserWindow and BaseWindow/WebContentsView routes can preserve different necessary pieces, and the BaseWindow compatibility bridge can now load a fully editable Board, but every fully initialized editable result remained an opaque rectangle. Renderer layers and canvas corners reported transparency, native and child-view transparency were reapplied, and no host `setBackgroundColor` mutation was observed. The remaining cause is unknown; see `docs/transparent-popout-investigation.md` for the evidence and failed variants.

If a future experiment validates this route, accepting it would require revisiting ADR 0003. Until then, ADR 0003 remains the current baseline and this document records only a proposed direction.
