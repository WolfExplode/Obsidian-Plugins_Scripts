---
status: accepted
---

# PureRef interchange is limited to the 1.x format

PureRef interchange is not implemented in this plugin. If it is added, the
supported target is the reverse-engineered PureRef 1.10/1.11.1 format; PureRef
2.x files remain out of scope.

The 2.x investigation found no general static-parsing route to recover placed
image bytes. The known working routes depend on a local PureRef installation,
which is not a viable requirement for an Obsidian import feature. See the
[PureRef 2.x format investigation](../investigations/pur-2x-format-investigation.md)
for the evidence and remaining unknown wrapper format.

Reconsider 2.x support only if a reliable standalone decoder or materially new
format evidence becomes available. Do not hold a possible 1.x implementation
behind speculative 2.x reverse engineering.
