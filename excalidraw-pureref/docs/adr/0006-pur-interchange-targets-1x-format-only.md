---
status: accepted
---

# Defer PureRef interchange; a future implementation targets 2.0 or newer

PureRef interchange has not been implemented. The available reverse-engineered `purformat` reference code only covers PureRef 1.10/1.11.1's binary format. PureRef 2.0 changed the format for save/load performance, and no reference implementation is currently available; supporting it may require a substantial reverse-engineering effort.

Interchange is deferred until the application has reached practical PureRef feature parity. Implementing the obsolete 1.10/1.11.1 format first would spend effort on compatibility that few users need and would not resolve migration from current PureRef installations.

When interchange work begins, PureRef 2.0 or newer compatibility is the required target for both import and export. The old-format reference code may still inform the investigation, but old-format-only support is not a product milestone. The uncertainty and cost of the 2.0+ format should be assessed before committing to delivery.
