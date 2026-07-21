---
status: accepted
---

# Current Popout keeps its title bar; frameless is deferred

The Popout aims to approach PureRef's frameless presentation. The current Obsidian `openPopoutLeaf()` retains its title-bar behavior. The project has not yet established a reliable way to create the same usable Popout as a transparent, frameless native window.

The accepted baseline keeps the title bar and strips only the in-page chrome while applying always-on-top behavior. Frameless presentation remains a candidate rather than a committed implementation; ADR 0007 does not supersede this baseline unless its proposal is validated and accepted.
