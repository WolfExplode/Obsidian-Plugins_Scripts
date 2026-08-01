---
status: rejected
---

# Reject a transparent, frameless editable Popout via a window-open handler

PureRef's defining visual effect requires transparency around reference images.
We investigated requesting `transparent: true` and `frame: false` while Obsidian
creates an editable Popout, along with BrowserWindow and
BaseWindow/WebContentsView variants.

The proposal is rejected. Every fully initialized editable Board remained
opaque, even when its renderer and native window layers reported transparency.
An independently bootstrapped Obsidian workspace window was also ruled out, and
patching Obsidian's bundled application is both low-confidence and not durable
across updates. The evidence and rejected variants live in the
[transparent Popout investigation](../investigations/transparent-popout-investigation.md).

ADR 0008's separate editable and transparent windows are the accepted design;
ADR 0003 remains the editable Popout baseline. Reopen this decision only for a
material platform or dependency change, not to repeat the documented renderer
or host experiments.
