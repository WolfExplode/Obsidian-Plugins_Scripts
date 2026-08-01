---
status: accepted
---

# Use upstream Excalidraw first; retain a narrow patch or fork as an escape hatch

This product uses Obsidian as its host, the upstream Excalidraw community plugin
as its drawing surface, and a separate host plugin to drive Boards and Popouts.
Rebuilding either platform or adding speculative portability seams is out of
scope.

Upstream Excalidraw owns behavior it can already express. In particular, use
native gestures for transforms and other relationship-aware operations so
bindings, frames, snapping, and history retain upstream semantics. Direct
element-field mutations are reserved for behavior with no suitable native
operation and go through the shared durable mutation seam documented in
[Excalidraw canvas mutations](../integrations/excalidraw-canvas-mutations.md).

If a defining requirement is conclusively blocked by the public runtime, DOM
integration, or file format, a narrow maintained patch or fork remains
acceptable. It must address a concrete blocker and stay as small as practical;
speculative divergence remains rejected. Replacing Obsidian would be a separate
product migration, not an implementation detail hidden behind an abstraction.
