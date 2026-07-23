# Documentation map

Start here when orienting yourself in this plugin's behavior and constraints.

| Need | Read |
| --- | --- |
| Why the plugin integrates with, rather than forks, Excalidraw | [ADR 0001](adr/0001-standalone-plugin-depends-on-excalidraw.md) |
| Decisions and product constraints | [Architecture Decision Records](adr/) |
| Generated images, Excalidraw binary state, and vault persistence | [Obsidian–Excalidraw generated-image lifecycle](integrations/obsidian-excalidraw-generated-images.md) |
| Popout lifecycle and ownership | [Popout lifecycle](popout-lifecycle.md) |
| Investigations and rejected/paused platform routes | [Transparent Popout investigation](transparent-popout-investigation.md), [illegal-access investigation](illegal-access-investigation.md) |

## Documentation conventions

- **ADRs** capture a durable decision: what was chosen, why, and the boundary it
  establishes.
- **Integration guides** capture reusable runtime contracts with Obsidian,
  Excalidraw, Electron, or another external system. They should be read before
  changing code that crosses that boundary.
- **Investigations** preserve evidence, experiments, and unresolved questions;
  they are not automatically accepted product behavior.
