---
status: accepted
---

# Editable Popout keeps its native title bar

The editable Popout uses Obsidian's `openPopoutLeaf()` and retains its native title bar. The title bar provides reliable movement, focus, resizing, and recovery for the mode in which the user is actively editing a Board.

This is accepted product behavior rather than a temporary v1 compromise. The editable Popout strips in-page chrome and applies always-on-top behavior, while the separate transparent read-only mode in ADR 0008 provides the frameless PureRef-style presentation. ADR 0007 records why a single transparent, frameless editable Popout was rejected.
