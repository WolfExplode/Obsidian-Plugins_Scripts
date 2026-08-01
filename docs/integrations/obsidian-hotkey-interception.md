# Obsidian hotkey interception

## Scope

This guide defines the runtime contract for **claiming a keyboard shortcut
conditionally**, so the host plugin owns it on a Board and the normal Obsidian
keymap owns it everywhere else. It applies whether or not another plugin or a
core command currently uses the key.

The implementation lives in
[rotation-reset-hotkey.ts](../../src/rotation-reset-hotkey.ts). Alt+R resets the
selected elements' rotation while a Board is active. Templater commonly binds
the same key to `templater-obsidian:replace-in-file-templater`, which errors on a
drawing ("Active editor is null"); the Board-scoped binding also prevents that
conflict. Users without an existing Alt+R binding get the same reset behavior.

This behavior was verified against the live Obsidian runtime (Obsidian's
`HotkeyManager` internals are not part of its public API). Re-verify after an
Obsidian upgrade before trusting it.

## Why a DOM keydown listener does not work

The obvious approach — a capture-phase `keydown` listener on `window` that calls
`stopImmediatePropagation` — **cannot** preempt an Obsidian hotkey:

- Obsidian's `Keymap.onKeyEvent` is itself a **window-capture** `keydown`
  listener, registered at app startup, before any plugin loads.
- Same target, same phase → listeners fire in **registration order**, so
  Obsidian's runs first. When it matches a registered hotkey it executes the
  command and stops propagation; a plugin's later-registered listener never sees
  the event.

This is why the plugin's other keyboard features (pack, transform, opacity) *can*
use DOM capture: their keys (G/R/S, Ctrl+Arrow, …) are **not** Obsidian hotkeys,
so `onKeyEvent` ignores them and lets them fall through to plugin listeners. A key
that *is* an Obsidian hotkey must be intercepted inside the keymap instead.

## How the keymap resolves a hotkey

Three `HotkeyManager` behaviors, observed from the live runtime, define the
contract:

| Mechanism | Behavior | Consequence for us |
| --- | --- | --- |
| `onTrigger` | Iterates `bakedHotkeys` in order; for the first entry that matches the event, runs its command via `app.commands.executeCommand` and **stops if that returns true**. | Whoever is baked **first** and runs, wins. |
| `executeCommand` | Runs the command and returns `true` unless the command *throws*. A `checkCallback` returning `false` still makes `executeCommand` return `true`. | A `checkCallback` that "declines" does **not** fall through to the next command. Conditional shadowing must be done by adding/removing the binding, not by returning false. |
| `bake` | Builds `bakedHotkeys` from the **custom-keys store first**, then defaults (skipping commands already customised). | A binding placed in the custom store outranks any command's *default* hotkey — including Templater's default Alt+R. |
| `setHotkeys` / `removeHotkeys` | Mutate only the in-memory custom-keys store and set `baked = false`. They do **not** write `hotkeys.json`; `save()` is separate. | We can toggle a binding every leaf change with no disk writes and no config pollution. |

## Required approach

To claim `<hotkey>` for command `<id>` only in context C:

1. Register a normal command (`plugin.addCommand`) with **no** default hotkey.
   Its callback re-checks context C defensively before acting. Once assigned,
   the command consumes the hotkey even when the operation is a no-op; ownership
   must not change based on transient selection state.
2. Toggle the binding by context, using the full command id
   (`${manifest.id}:${subId}`):
   - Entering C → `app.hotkeyManager.setHotkeys(fullId, [{ modifiers, key }])`
     (custom store → baked first → outranks the incumbent).
   - Leaving C → `app.hotkeyManager.removeHotkeys(fullId)` (incumbent is the only
     match again → it runs normally).
   Drive the toggle from `workspace.on("active-leaf-change")` and
   `"layout-change")`; guard with a boolean so redundant calls don't invalidate
   the bake needlessly.
3. On dispose, `removeHotkeys(fullId)` if still assigned. The command is removed
   by Obsidian on plugin unload.

Because this rides Obsidian's global keymap — which already spans popout windows —
**one registration covers the main window and every popout**. Do not add
per-window wiring for keymap-level shortcuts (contrast the DOM-capture features,
which must be attached per window — see
[Obsidian window event listeners](obsidian-window-event-listeners.md), which also
documents how events route between windows and why gesture state must not live in
a per-window closure).

For the Board-vs-markdown test specifically, `isExcalidrawLeaf(activeLeaf)` is
the correct signal: the host's "toggle Excalidraw/Markdown" swaps the leaf's view
*type*, so an active Board is exactly a leaf of type `excalidraw`. No dependency
on the Excalidraw plugin's code is required (see
[ADR 0001](../adr/0001-standalone-plugin-depends-on-excalidraw.md)).

## Known edge

`setHotkeys` writes to the store that `HotkeyManager.save()` persists. If the user
edits hotkeys in Settings while the transient binding is present (the active leaf
is a drawing), Obsidian may persist it to `hotkeys.json`. This is cosmetic: the
plugin re-manages the binding on every load, and an orphaned entry for an
unknown command id is ignored. Add an explicit guard only if it proves annoying.
