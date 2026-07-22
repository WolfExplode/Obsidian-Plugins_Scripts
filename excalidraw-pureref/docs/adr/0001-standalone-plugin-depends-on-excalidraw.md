---
status: accepted
---

# Use upstream Excalidraw first; retain a narrow patch or fork as an escape hatch

We want a controllable PureRef replacement while avoiding the cost and risk of rebuilding a mature drawing surface. The current implementation therefore uses Obsidian and the upstream Excalidraw community plugin for leverage, with a separate host plugin that drives Boards and Popouts from the outside.

Upstream Excalidraw is the default because it avoids a large maintenance burden and already supplies most of the required Board behavior. External integration is a strategy for reusing that work, not a permanent product constraint. If a defining product requirement is conclusively blocked by the public runtime interface, DOM integration, or file format, a narrow maintained patch or fork remains acceptable. Such a change should be justified by a concrete blocker and kept as small as practical; speculative divergence is still rejected.

Obsidian is the required host for the current product. The implementation intentionally relies on its vault, workspace, plugin, and Popout behavior; no portability seam or standalone host is being built speculatively. If Obsidian later becomes a proven blocker, replacing it would be evaluated as a substantial product migration with its own costs and decisions, not treated as an implementation detail hidden behind premature abstractions.

The host plugin has no runtime dependency on synaptic-hatch or ui-tweaker. Their patterns may be adapted narrowly for always-on-top window control and chrome hiding rather than importing unrelated settings and behavior. The same upstream-first principle applies: reuse mature behavior where it fits, and own only the implementation needed to deliver the product.
