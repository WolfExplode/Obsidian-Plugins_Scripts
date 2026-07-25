# Obsidian window event listeners

## Scope

This guide defines the runtime contract for **attaching DOM event listeners in a
plugin that must work in the main window and in Popout windows**. It covers where
to attach, how to dispose, and — the part that is easy to get wrong — how events
are routed between windows.

It is the companion to [Obsidian hotkey interception](obsidian-hotkey-interception.md):
that guide covers keys owned by Obsidian's keymap (one registration, global);
this one covers everything handled with DOM listeners (attached **per window**).

Read this before adding any feature that listens for keyboard, pointer, or drag
events. The routing rule below was established empirically against the live
runtime (see [Evidence](#evidence)); re-verify after an Obsidian upgrade.

## The two listener models

| Model | Use for | Attach point | Covers Popouts? |
| --- | --- | --- | --- |
| **Obsidian keymap** | Keys that are registered Obsidian hotkeys | `app.hotkeyManager` once | Yes, automatically |
| **DOM capture** | Keys Obsidian does not bind (G/R/S, Ctrl+Arrow, …), and all pointer/drag events | `window` / `document`, once **per window** | No — you must attach to each window |
| **View subscription** | Reacting to scene changes rather than input | the view's own `onChange`, per leaf | No — reconcile across leaves |

## Attaching per window

DOM listeners reach only the window they are bound to, so every feature needs two
wiring sites:

1. **Main window** — in [main.ts](../../main.ts), `this.register(attachX(window, this.app))`.
   `Plugin.register` disposes it on unload.
2. **Each Popout** — in [popout-manager.ts](../../src/popout-manager.ts), inside the
   post-open finalize step, `entry.detachX = attachX(doc.defaultView, this.plugin.app)`.
   Store the disposer on the entry and call it when the Popout closes.

Conventions that matter:

- **Capture phase** (`addEventListener(type, fn, true)`) so the handler runs
  before Excalidraw's own document-bound, bubble-phase handlers.
- **Consume only on success** — `preventDefault()` + `stopImmediatePropagation()`
  only when the feature actually acted, so unrelated keys keep working.
- **Always return a disposer** and actually store it. Listeners attached to a
  Popout window outlive the leaf otherwise.
- **Gate on a leaf**, via `findExcalidrawLeafForNode(app, event.target)`, so the
  behavior applies inside a Board and nowhere else. That helper resolves the leaf
  whose container holds the target, and falls back to the only Excalidraw view in
  the event's document — which is what makes it work for Popouts, where focus
  commonly sits on the window body rather than the canvas.

For scene reactions rather than input, prefer the view-subscription model:
subscribe to each view's `onChange` and reconcile across leaves on
`layout-change` / `active-leaf-change`. See [video-aspect.ts](../../src/video-aspect.ts)
for the established shape (seed-existing-as-seen, ready-retry while the API
mounts, prune on teardown).

## Cross-window event routing (the important part)

**A Popout does not receive all of its own events.** Observed behavior:

| Event | Where the listener actually fires |
| --- | --- |
| **Keyboard** (real keypress in a Popout) | The **main window's** listeners |
| **Pointer / mouse** (in a Popout) | The **Popout's** listeners |

So a single user gesture that combines a keypress with mouse movement is split
across two windows' handler instances.

### Consequence: never keep gesture state in a per-window closure

This is the rule to generalize. If a feature stores in-flight state in the
closure created by its per-window attach function, a Popout gesture breaks:
the instance that received the keydown holds the state but never sees the mouse,
and the instance seeing the mouse has no state. Each half works; the gesture
never completes, silently and with no error.

That is exactly how the Blender-style G/R/S transforms failed in a Popout: the
main window's instance activated the transform (resolving the *Popout's* leaf
correctly), while the Popout's instance received every `pointermove` with its own
`active === null`.

**Required approach** for any multi-event gesture (key-then-drag, hold-then-drag,
anything spanning more than one event):

1. Hoist the in-flight state to **module level** so every window's instance shares
   one gesture. See `active` / `lastPointer` in [transform-keys.ts](../../src/transform-keys.ts).
2. Address side effects to the **target leaf's own document**
   (`leaf.view.containerEl.ownerDocument`), never the `win.document` captured at
   attach time. With a Popout open they are frequently different windows — a
   cursor written to the capturing instance's document lands on the wrong screen.
3. Scope teardown to the owning window. With shared state, an unguarded
   `blur`/dispose handler will cancel a gesture another window owns — and the
   main window blurs the instant a Popout takes focus. Guard with an
   "do I own the active gesture?" check comparing the leaf's document to this
   instance's document.

Features that handle each event independently (opacity keys, pack keys, the
Alt+S blocker) are unaffected — they read the leaf per event and keep nothing
between events. Statelessness is the cheapest way to stay correct here.

## Testing pitfall: synthetic events do not reproduce routing

`element.dispatchEvent(new KeyboardEvent(...))` on a Popout node **is** delivered
to that Popout's listeners — real keypresses are not. Synthetic dispatch
therefore exercises a path the user never takes and can make a broken feature
look healthy (or vice versa).

Use synthetic events only to probe a specific handler in isolation. Confirm any
cross-window behavior with a **real keypress**, driving the diagnosis from
temporary logging inside the handler (gated behind a `window.__epr*Debug` flag,
the convention used by the aspect/crop debug hooks).

## Evidence

Established via the Obsidian DevTools MCP against a live Popout, with temporary
tracing inside `attachTransformKeydown`:

- A real `G` press in the Popout produced **exactly one** handler entry, and that
  instance reported `docIsLeafDoc: false` — its captured document was the main
  window's, identifying it as the main-window instance. The Popout's own instance
  never saw the keydown.
- Every `pointermove` in the Popout was handled by the Popout's instance and
  logged `hasActive: false`.
- A probe registered on the Popout window recorded **no** real keydowns, while
  recording synthetic ones dispatched into the same window.
- Ruled out along the way: handler not attached (it was), wrong leaf resolved
  (`findExcalidrawLeafForNode` was correct), another handler consuming the key
  (detaching every other handler changed nothing), stale document references
  (`entry.doc` matched the leaf's document exactly), and empty selection (a real
  selection was present and the baseline computed to 1).

### Unresolved

- The mechanism behind keyboard routing to the main window was not determined —
  only its behavior. Treat the routing table above as observed contract, not as
  documented Obsidian API.
- While debugging a long-lived Popout, calling **every** stored disposer on the
  entry still left some listeners responding, suggesting handlers can be attached
  more than once across open/close cycles. A plugin reload plus a fresh Popout did
  not reproduce it, and it was not the cause of the transform bug. If stale
  behavior is ever seen in a Popout that has been reopened several times, suspect
  duplicate attachment first.
