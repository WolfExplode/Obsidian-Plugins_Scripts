# Excalidraw PureRef

Excalidraw PureRef is a desktop-only Obsidian plugin for using an
[Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) Board as
a PureRef-style reference surface. Visit the [original app's website](https://www.pureref.com/) to find out the eventual intended feature set of this plugin. 

### Current status
As the plugin is now, it's fully functional as a reference board, but still lacks some of the features that make pureref, pureref. 

## What it does

- Open the active `.excalidraw` Board as a chrome-free, always-on-top Popout
  with the **F11** hotkey.
- Switch an existing Popout between editable mode and a separate transparent,
  read-only reference mode with **F10**. (This read only mode was the only way I managed to get some of the transparency features to render properly, if it feels clunky to use... I know)
- Add PureRef-oriented image crop, flip, pack, transform, opacity, media import/export.

`.pur` file import/export is not supported. PureRef's file format changed
between its 1.x and 2.x releases, and the 2.x format was not able to be reverse
engineered, so interchange is limited to the Board's native `.excalidraw`
file.

See the complete [interaction reference](docs/behavior/user-interaction-overrides.md).

## Requirements

- Obsidian Desktop 1.8.0 or newer.
- The [Obsidian Excalidraw community plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin).
- An active Excalidraw Board. This plugin extends that Board; it does not ship
  or fork Excalidraw.
- I have not tested mac or linux systems so consider this plugin windows only. 

## Install for development
This plugin is still in developement so it is not yet available on [community plugins](https://community.obsidian.md/plugins), pending review.

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

## Contributing

Feel free to open any issues or fork this repo and implement your own changes.