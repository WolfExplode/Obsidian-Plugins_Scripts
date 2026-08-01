# Documentation guide

This directory contains documentation maintained by this project. Start here to
find the right context before changing code or investigating behavior.

## Choose by intent

| You need to | Start here | Then use |
| --- | --- | --- |
| Understand a user-visible gesture, shortcut, or board behavior | [Behavior](behavior/) | [Interaction overrides](behavior/user-interaction-overrides.md) |
| Change code that crosses an Obsidian, Excalidraw, Electron, or plugin boundary | [Integrations](integrations/) | The guide for that boundary |
| Understand a durable architectural or product decision | [ADRs](adr/) | The ADR covering the decision |
| Understand Popout ownership and lifecycle | [Popout lifecycle](popout-lifecycle.md) | [Window event listeners](integrations/obsidian-window-event-listeners.md) |
| Work with vault images or an Excalidraw image element's `fileId` | [Generated-image lifecycle](integrations/obsidian-excalidraw-generated-images.md) | — |
| Load a vault file into a `<video>`/`<img>` by URL | [Media URL schemes](integrations/obsidian-media-url-schemes.md) | — |
| Check whether a rendering quirk is an accepted upstream limitation before investigating it as a bug | [Excalidraw embeddable z-order limitation](integrations/excalidraw-embeddable-z-order-limitation.md), [Excalidraw linear-element canvas offset](integrations/excalidraw-linear-element-canvas-offset.md), [Obsidian Canvas image-embed stretch fix](integrations/obsidian-canvas-image-stretch-fix.md) | — |
| Understand how elements render in front of embeddables (video/PDF/markdown/web embeds) | [Front-of-embed rendering](behavior/front-of-embed-rendering.md) | [ADR 0010](adr/0010-front-of-embed-rendering.md) |
| Research a known problem, failed experiment, or paused direction | [Investigations](investigations/) | Treat findings as context, not an implementation plan |
| Measure real interaction cost instead of guessing from reading code | [Performance profiling](perf-profiling.md) | — |

## Documentation map

| Area | What it contains | Status |
| --- | --- | --- |
| [behavior/](behavior/) | Product-facing interaction rules and overrides | Current behavior |
| [integrations/](integrations/) | Runtime contracts with external systems | Read before changing the relevant boundary |
| [adr/](adr/) | Durable architecture and product decisions | Accepted or explicitly proposed/rejected per ADR |
| [investigations/](investigations/) | Evidence, experiments, and unresolved questions | Historical or exploratory; not automatically accepted behavior |
| Root documents in this directory | Cross-cutting behavior and lifecycle material | Current unless marked otherwise |

## Common change routing

| If your change involves | Read first |
| --- | --- |
| Excalidraw gestures, shortcuts, selection, transforms, or crop interactions | [Interaction overrides](behavior/user-interaction-overrides.md) and [Excalidraw shortcut interception](integrations/excalidraw-shortcut-interception.md) |
| Direct changes to existing Excalidraw element fields or undo history | [Excalidraw canvas mutations](integrations/excalidraw-canvas-mutations.md) |
| Vault images, generated images, or Excalidraw `fileId` values | [Generated-image lifecycle](integrations/obsidian-excalidraw-generated-images.md) |
| A shortcut owned by Obsidian or another plugin | [Obsidian hotkey interception](integrations/obsidian-hotkey-interception.md) |
| Dropped/imported attachment filenames or wikilink-unsafe characters | [Obsidian wikilink-unsafe attachment names](integrations/obsidian-wikilink-attachment-names.md) |
| Window-, Popout-, or DOM-level event listeners | [Obsidian window event listeners](integrations/obsidian-window-event-listeners.md) and [Popout lifecycle](popout-lifecycle.md) |
| The plugin Settings tab or its search indexing | [Obsidian declarative settings](integrations/obsidian-declarative-settings.md) |
| Local media loaded by URL in any window (`file://` vs `getResourcePath`) | [Media URL schemes](integrations/obsidian-media-url-schemes.md) |
| Anything that has to land on the pixels Excalidraw drew for a line, arrow, or freedraw | [Excalidraw linear-element canvas offset](integrations/excalidraw-linear-element-canvas-offset.md) |
| Architecture, scope, or product-boundary changes | The relevant [ADR](adr/) before implementation |
| Transparent Popouts or `Uncaught illegal access` | The relevant [investigation](investigations/) and its linked ADRs; do not treat experimental routes as current behavior |

## Reading investigations

Investigation documents preserve observed evidence and paths that were rejected,
paused, or still uncertain. They are useful for avoiding repeated work, but they
do not define the product. An ADR or behavior/integration guide is the source of
truth when one exists.
