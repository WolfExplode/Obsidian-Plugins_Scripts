# Excalidraw shortcut interception

## Scope

This guide covers claiming a keyboard shortcut that **Excalidraw itself** owns
(as opposed to an Obsidian-level hotkey — see
[Obsidian hotkey interception](obsidian-hotkey-interception.md) for that case,
including why the two require opposite techniques). It applies to G/R/S (modal
move/rotate/scale) and the Alt+R/Alt+S resets, all implemented in
[transform-keys.ts](../../src/transform-keys.ts).

This was verified against `reference/excalidraw-master`,
**Excalidraw core version 0.18.0** — the version bundled by
**obsidian-excalidraw-plugin 2.25.3**, the live plugin version at the time of
writing. Excalidraw's shortcut wiring is not part of its public API. Re-verify
against the matching tag in that reference tree after the bundled plugin's
version changes, before trusting anything below.

## Why a DOM capture-phase listener *does* work here

Contrast with the Obsidian case: Excalidraw's own shortcuts are **not** wired
through anything registered before plugins load. Every shortcut is a hardcoded
`keyTest(event)` closure baked into that shortcut's action definition — for
example (0.18.0):

- `actions/actionZindex.tsx` — `Ctrl/Cmd+[`, `Ctrl/Cmd+]`, and their
  Shift/Alt variants for send-backward/bring-forward/send-to-back/bring-to-front.
- `actions/actionFlip.ts` — `Shift+H` / `Shift+V`.
- Tool registration — `R` selects the rectangle tool, `S`/`V` etc. select other
  tools.

All of these are dispatched by `actions/manager.tsx`'s `handleKeyDown`, wired to
a **document-level, bubble-phase** `keydown` listener added in
`components/App.tsx` (`addEventListener(document, EVENT.KEYDOWN, this.onKeyDown,
false)`, ~line 3975 in the 0.18.0 tree).

Because that listener is bubble-phase, our own `win.addEventListener("keydown",
onKeyDown, true)` (capture-phase, in `attachTransformKeydown`) always runs first
and can call `stopImmediatePropagation()` to keep the event from ever reaching
Excalidraw's handler. This is the mirror image of the Obsidian case, where the
incumbent listener is *also* capture-phase and registered before any plugin, so
a plugin's capture listener loses that race and interception has to happen
inside Obsidian's `HotkeyManager` instead.

## Undo-history gotcha this workaround depends on

`applySelectionTransform` (in [excalidraw-view.ts](../../src/excalidraw-view.ts))
drives the G/R/S preview by calling Excalidraw's `updateScene` with a
`captureUpdate` action on every pointer-move frame, then again once on commit.
`packages/element/src/store.ts`'s `Store.processAction` (0.18.0) determines what
each action does to the undo snapshot:

| `captureUpdate` value | Emits a durable (undoable) increment? | Advances the undo snapshot? |
| --- | --- | --- |
| `IMMEDIATELY` | Yes | Yes |
| `NEVER` | No | **Yes** |
| `EVENTUALLY` | No | No |

The live preview frames must use `EVENTUALLY`, not `NEVER` — using `NEVER` still
advances the snapshot on every mouse-move, so by the time the final commit fires
`IMMEDIATELY` the diff against that (already-advanced) snapshot is empty and
nothing reaches the undo stack. (This was a real regression, fixed 2026-07-23:
G/R/S transforms were silently not undoable.) If G/R/S stop showing up in undo
history again after a version bump, check this switch first.

## Required approach

To claim a plain (non-modifier-locked) Excalidraw shortcut for a plugin feature:

1. Attach a **capture-phase** `keydown` listener per window (main window and
   each Popout — unlike the Obsidian keymap case, this does need per-window
   wiring; see
   [Obsidian window event listeners](obsidian-window-event-listeners.md)).
2. Match on `event.code` (not `event.key`, which is layout-dependent) against
   the same `CODES` constant Excalidraw's own action uses, so behavior doesn't
   drift if Excalidraw changes a binding.
3. Call `event.preventDefault()` and `event.stopImmediatePropagation()`
   unconditionally for any code you're reserving, even when your feature has
   nothing to do (e.g. no selection) — letting it fall through inconsistently is
   worse than a harmless no-op, and is exactly what happened before Alt+R/Alt+S
   were made to consume unconditionally.
4. If the feature also drives `updateScene` during a live preview, use
   `EVENTUALLY` for preview frames and `IMMEDIATELY` only for the final commit —
   see the gotcha above.

## Known edge

None currently open. If Excalidraw ever moves its own `onKeyDown` listener to
capture-phase, this whole approach breaks silently (our listener would still run
first only by registration order, which is fragile) — that would need a redesign,
not a patch.
