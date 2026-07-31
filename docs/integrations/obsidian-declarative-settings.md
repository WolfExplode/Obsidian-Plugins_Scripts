# Obsidian declarative settings

The host plugin requires Obsidian **1.13.0 or later** (`manifest.json` and
`versions.json`). Its Plugin settings tab therefore uses Obsidian's declarative
settings API: `PluginSettingTab.getSettingDefinitions()`.

The hotkey recorder and the geometry-reset button need custom controls, so they
are declarative `render` definitions rather than standard `control` definitions.
That still gives Obsidian the setting names, descriptions, and aliases it needs
to index them in Settings search. A `render` callback does not save data
automatically; the hotkey controls must continue to persist through
`HotkeyStore`, while geometry is persisted by `GeometryStore`.

Do not add a `display()` implementation as a fallback unless the plugin's
minimum Obsidian version is deliberately lowered below 1.13.0. On 1.13.0+ a
non-empty `getSettingDefinitions()` result is rendered instead of `display()`.
After a custom control changes data that affects the settings layout, call
`this.update()` — not `display()` — so the search index and rendered rows stay
in sync.

## Verification

On Obsidian 1.13.0+, confirm that:

- the developer-console warning about a missing `getSettingDefinitions()` is
  absent;
- every hotkey and the popout-geometry reset action can be found in Settings
  search;
- recording or resetting a hotkey refreshes its binding and conflict state.
