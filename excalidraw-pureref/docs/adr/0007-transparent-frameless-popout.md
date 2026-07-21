---
status: proposed
---

# Proposed transparent, frameless Popout via a window-open handler

PureRef's defining visual effect is a genuinely see-through surface around the reference images. A main-process `setWindowOpenHandler` was proposed as a way to request `transparent: true` and `frame: false` when Obsidian creates a Popout through `window.open`.

The proposal is **not accepted, and investigation is paused as of 2026-07-21**. The checked-in v10 F10 diagnostic is not product behavior. BrowserWindow and BaseWindow/WebContentsView routes can preserve different necessary pieces, and the BaseWindow compatibility bridge can now load a fully editable Board, but every fully initialized editable result remained an opaque rectangle. Renderer layers and canvas corners reported transparency, native and child-view transparency were reapplied, and no host `setBackgroundColor` mutation was observed. The remaining cause is unknown; see `docs/transparent-popout-investigation.md` for the evidence and failed variants.

Scope clarification: all tested live editable variants still used the guest WebContents originating from Obsidian's `window.open("about:blank", ...)` flow. An independently constructed BrowserWindow containing an independently bootstrapped live Obsidian WorkspaceWindow/leaf has been investigated (v11, 2026-07-21) and ruled out by live inspection: Obsidian's `WorkspaceWindow` constructor requires a live, synchronously-writable `Window` reference that only `window.open` can provide to the calling renderer, so any such window is necessarily a `window.open` child covered by the already-failed override experiment above. An Obsidian `asar` patch at the original construction point remains the one untried route, but is downgraded to low-expected-value on reassessment (2026-07-21, see investigation doc): `setWindowOpenHandler`'s `overrideBrowserWindowOptions` already delivers the same options at what is likely the same Electron construction point an `asar` patch would target, and that already failed; a patch is also not durably deployable against Obsidian's auto-updating, per-build-minified bundle. Transparent direct controls and the transparent static snapshot do not answer that question.

If a future experiment validates this route, accepting it would require revisiting ADR 0003. Until then, ADR 0003 remains the current baseline and this document records only a proposed direction.
