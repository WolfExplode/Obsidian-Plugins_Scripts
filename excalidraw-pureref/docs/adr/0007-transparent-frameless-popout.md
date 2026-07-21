# Transparent, frameless Popout via a main-process window-open handler

Supersedes [ADR 0003](0003-native-title-bar-for-v1-popout.md) (which kept the native title bar and deferred frameless).

## Context

PureRef's defining look is a genuinely see-through window: opaque reference images floating directly over the desktop, everything else transparent. ADR 0003 deferred this because Electron window transparency is fixed at `BrowserWindow` **creation** time and an Obsidian plugin appeared to have no creation-time hook.

Empirical investigation (live, via CDP) established:

- This Electron build **does** render `transparent: true` windows see-through.
- Transparency **cannot** be retrofitted onto an existing window (`setBackgroundColor('#00000000')` collapses to opaque `#000000`).
- Obsidian creates a Popout via the renderer's `window.open("about:blank", "_blank", features)`. Its feature parser honors `background=`/`x/y/w/h` but **ignores `transparent`**.
- The sanctioned lever, `webContents.setWindowOpenHandler`, must return **synchronously in the main process**. Installed from the renderer over `@electron/remote`, it returns too late and `window.open` yields `null` (breaks Popouts).
- `@electron/remote.require(<absolute path>)` executes a module **in the main process**. A handler installed from there returns in time.
- Per Electron docs, `overrideBrowserWindowOptions` is **merged** over the inherited webPreferences, so `transparent`/`frame` can be added without stripping the preload/node bridge the Popout needs.
- On Windows a transparent window must be **frameless** (`frame: false`).

## Decision

When the `transparentBackground` setting is on, a Popout is created transparent + frameless:

1. `electron-main-helper.cjs` runs in main (loaded via `@electron/remote.require`) and exposes `begin(openerWindowId)` / `end(openerWindowId)` that install/remove a `setWindowOpenHandler`. The handler transforms **only** windows whose feature string carries the `epr-transparent-popout` marker; all other `window.open` calls pass through untouched.
2. `src/transparent-window.ts` brackets exactly the plugin's own `openPopoutLeaf()` call: install handler → patch `window.open` to append the marker → run → restore `window.open` → remove handler. The handler is therefore live only for the synchronous popout creation and never affects Obsidian's other `window.open` usage (e.g. external-link routing).
3. Frameless means no OS title bar, so we now also hide Obsidian's in-page `.titlebar` (chrome-hider / styles.css). The already-shipped RMB window-drag and F11 close cover the lost chrome — the interaction cost ADR 0003 worried about is already paid.
4. For the window to actually show through, the DOM and canvas must be transparent too: chrome-hider clears the opaque theme layers inline (styles.css mirrors it), and popout-manager forces Excalidraw's `viewBackgroundColor` to `transparent`, snapshotting and restoring the prior value on close (it lives in the shared scene).

Default is **off** — existing opaque behavior is unchanged, and the setting only affects Popouts opened after it is toggled.

## Consequences

- Delivers the signature PureRef effect that motivated the whole plugin.
- Windows desktop only (aligns with [ADR 0004](0004-max-priority-always-on-top.md)); degrades gracefully to an opaque Popout if the Electron bridge or helper is unavailable.
- New coupling to Obsidian/Electron internals: `@electron/remote.require`, patching `window.open`, and the assumption that Obsidian relies on Electron's default window-open handler. All hold today; a future Obsidian/Electron change could require revisiting. This is an accepted, isolated risk — confined to two small files and gated behind an off-by-default setting.
- A transparent Popout is frameless and (being frameless) has no OS resize chrome; window moves use the existing RMB-drag. Edge-resize ergonomics are a known follow-up.

