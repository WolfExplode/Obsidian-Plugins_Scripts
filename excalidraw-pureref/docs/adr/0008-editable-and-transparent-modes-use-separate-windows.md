---
status: accepted
---

# Editable and transparent modes use separate windows

A live editable Excalidraw Board and a genuinely transparent native surface cannot currently be combined reliably within Obsidian's Popout construction path. The attempted renderer, BrowserWindow, BaseWindow, and WebContentsView routes are recorded in ADR 0007 and `docs/transparent-popout-investigation.md`.

The product therefore has two modes backed by separate windows. The editable mode uses Obsidian's ordinary Popout and a fully live Excalidraw view. The transparent read-only mode uses a dedicated transparent window containing a rendered representation of the same Board. Switching modes carries across window geometry, opacity, and camera framing so the two surfaces behave as one workflow from the user's perspective.

This is accepted product behavior rather than a temporary diagnostic. The separation preserves mature Excalidraw editing and delivers the transparent reference surface without maintaining a fork or sacrificing reliability. The transparent mode is intentionally read-only; editing resumes by switching back to the editable Popout.
