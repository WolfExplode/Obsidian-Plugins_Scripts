# Excalidraw PureRef

Excalidraw PureRef is a desktop-only Obsidian plugin for using an
[Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) Board as
a PureRef-style reference surface. Visit https://www.pureref.com/ to find out the eventual intended feature set of this plugin. 


> This is an early, development-stage plugin. Use it with a backup of your
> vault and expect the interaction set to evolve.

### Current status
As the plugin is now, it's fully functional as a reference board, but still lacks some of the features that make pureref, pureref. 

## What it does

- Open the active `.excalidraw` Board as a chrome-free, always-on-top Popout
  with the **F11** hotkey.
- Switch an existing Popout between editable mode and a separate transparent,
  read-only reference mode with **F10**. (This read only mode was the only way I managed to get some of the transparency features to render properly, if it feels clunky to use... I know)
- Add PureRef-oriented image crop, flip, pack, transform, opacity, media import/export. The ability to import/export existing .pur files (not yet implemented)

See the complete [interaction reference](docs/behavior/user-interaction-overrides.md).

## Requirements

- Obsidian Desktop 1.8.0 or newer.
- The [Obsidian Excalidraw community plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin).
- An active Excalidraw Board. This plugin extends that Board; it does not ship
  or fork Excalidraw.
- I have not tested mac or linux systems so consider this plugin windows only. 

## Install for development
This plugin is still in developement so it is not yet available on [community plugins](https://community.obsidian.md/plugins)

1. Clone this repository into your vault's `.obsidian/plugins/excalidraw-pureref/`
   folder.
2. Run `npm install` in the repository root.
3. Run `npm run build` after every source change.
4. In Obsidian, enable both **Excalidraw** and **Excalidraw PureRef** in
   Community plugins.

## Documentation

The [documentation guide](docs/README.md) routes both users and contributors to
the right material.

For contributor workflow and repository-specific guardrails, see
[AGENTS.md](AGENTS.md).
