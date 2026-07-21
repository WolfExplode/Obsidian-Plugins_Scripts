---
status: accepted
---

# PureRef interchange targets the 1.10/1.11.1 `.pur` format only, not 2.0

PureRef interchange (ADR 0005, CONTEXT.md) is built on the reverse-engineered `purformat` reference code, which covers PureRef 1.10/1.11.1's binary format. PureRef 2.0 changed the format again for save/load performance, and no reference implementation exists for it — supporting it would mean reverse-engineering an undocumented binary format from scratch, a substantial open-ended research project on its own.

v1 targets 1.10/1.11.1 only. Export in this format should remain broadly usable since PureRef 2.0 can still open old-format files, but importing genuine PureRef 2.0-saved files is not supported. Reverse-engineering the 2.0 format is anticipated as a real future need, not a rejected idea — just undone.
