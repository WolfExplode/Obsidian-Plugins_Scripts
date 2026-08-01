# Excalidraw shortcut interception

## Scope

This guide covers claiming a keyboard shortcut that **Excalidraw itself** owns
(as opposed to an Obsidian-level hotkey — see
[Obsidian hotkey interception](obsidian-hotkey-interception.md) for that case,
including why the two require opposite techniques). It applies to G/R/S (modal
move/rotate/scale) and the Alt+S reset, all implemented in
[transform-keys.ts](../../src/transform-keys.ts). Alt+R is an Obsidian-keymap
command implemented separately in
[rotation-reset-hotkey.ts](../../src/rotation-reset-hotkey.ts).

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

## G/R/S must use Excalidraw's pointer transform pipeline

The modal operators do not rewrite `x`, `y`, `width`, `height`, or `angle`
through `updateScene`. That bypasses the logic a real pointer transform runs for
bound text, connected arrows, linear-element points, frames, font sizes,
snapping, and history.

Instead, `transform-keys.ts` temporarily adds an invisible rectangle matching
the selection's common bounds and selects it together with the real elements.
That proxy gives Excalidraw one deterministic native selection box regardless
of whether the real selection is an embeddable, line, text, frame, or irregular
shape. The bridge starts its pointer gesture at the proxy selection's interior
for G, rotation handle for R, or corner-resize handle for S. Physical pointer
motion is translated into that virtual gesture, and commit/cancel ends it with
the same pointer-up path as a mouse drag. Excalidraw therefore remains the sole
owner of transform semantics for the real elements.

Proxy bounds for lines, arrows, and free-draw elements must come from their
local `points`, translated by `x/y` and rotated about the point-derived centre.
For these element types `x/y` is a local point origin, not the visual top-left;
reversed arrows commonly have points whose X coordinates are entirely negative.
Treating `x/y/width/height` as an ordinary rectangle mirrors the proxy to the
wrong side and makes the calculated native rotation handle miss.

Proxy insertion and removal use `CaptureUpdateAction.EVENTUALLY`, and removal
occurs before native pointer-up. Their net scene diff is therefore zero when the
native gesture captures its durable update, leaving only the real transform in
undo history. Do not use `NEVER` here: Excalidraw 0.18 advances the store's undo
comparison snapshot for `NEVER`, which would swallow the transform before
pointer-up captures it. Gesture start polls the observable scene/selection state
on animation frames and does not dispatch pointer-down until Excalidraw reports
the proxy ready; this is a data condition, not a timing delay.

An active iframe/embeddable is another required precondition. Excalidraw's own
drag branch explicitly refuses to move selected elements while
`activeEmbeddable.state === "active"`; without normalizing it, the same valid
pointer stream grows the selection marquee instead. Proxy installation clears
`activeEmbeddable` (the state transition a native click outside the embed makes),
and readiness also verifies that the clear has reconciled before pointer-down.

Pointer-down and the first relayed pointer-move must also occur in separate
animation frames. A physical mouse cannot produce both in one browser task, and
Excalidraw/React batches the pointer-down state that installs the drag. Sending a
move synchronously after down intermittently routes that move through the
selection tool instead, producing a marquee even though Excalidraw reported the
proxy and common selection box as hit.

Excalidraw throttles its pointer-move handler to an animation frame. Commit and
cancel issue the final virtual position first, then the pointer-up on the next
animation frame. This is synchronization with the native event pipeline, not a
wall-clock race workaround.

Physical pointer movement and the LMB/RMB release paired with the user's
commit/cancel press must be consumed while that next frame is pending. A real
move with the button held can otherwise reach Excalidraw immediately before the
virtual pointer-up and apply the real cursor coordinate to the virtual drag,
jumping the selection centre there. Only pointer events marked as belonging to
the bridge are allowed through during modal cleanup.

Cancel also restores a deep pre-gesture snapshot with
`CaptureUpdateAction.EVENTUALLY` immediately before that native pointer-up.
Returning the virtual pointer to its starting coordinate is not an exact inverse:
Excalidraw may reapply snapping and binding corrections there. The snapshot
covers the complete element array because a native transform can mutate related
bound text, arrows, and frame members outside `selectedElementIds`.

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
   worse than a harmless no-op. Alt+S therefore consumes unconditionally; Alt+R
   follows the equivalent rule in the Obsidian keymap module.
4. While a modal transform is active, consume every unrelated keydown and keyup.
   In particular, Alt+S must not reach Excalidraw's object-snap toggle during an
   operation. Escape, Enter, numeric S input, and pointer modifiers are handled
   explicitly by the bridge.

## Known edge

None currently open. If Excalidraw ever moves its own `onKeyDown` listener to
capture-phase, this whole approach breaks silently (our listener would still run
first only by registration order, which is fragile) — that would need a redesign,
not a patch.
