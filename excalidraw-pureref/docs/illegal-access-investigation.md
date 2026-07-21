# `Uncaught illegal access` during Popout close

## Status

The plugin-side lifecycle race has been hardened, but rapid open/close testing
still reproduces the error. The remaining error is not proven to originate in
the plugin and is likely in Obsidian/Electron's Popout renderer teardown path,
or in a race between that teardown and Excalidraw/Obsidian's window cleanup.

## Reproduction

On 2026-07-21, with Obsidian 1.12.7 and the rebuilt plugin:

1. Open an Excalidraw Board.
2. Open and close the PureRef Popout repeatedly and quickly.
3. The console reports grouped entries such as `3 Uncaught illegal access`
   from `index.html:1` after Popout close.
4. During an automated rapid-cycle run, the DevTools page disconnected from
   the Obsidian renderer. The Obsidian processes remained running and
   responsive, so this was a renderer/CDP disconnect rather than a confirmed
   application-process crash.

The error is emitted by the Popout/main renderer target, not by a source-mapped
plugin line. The available Obsidian MCP console capture only observes the main
renderer and cannot retain the Popout's stack after that renderer closes.

## Plugin changes made

- Cancel pending Popout-window identification when close begins.
- Mark tracked Popouts as closing and reject stale async continuations after
  focus waits.
- Stop focus polling and canvas-finalization callbacks when the window is
  closed or the tracked entry has changed.
- Handle a close that occurs before the document marker is installed.
- Avoid calling Electron's remote `removeListener()` after the native `close`
  event has fired, and guard the best-effort cleanup call.

These changes compile successfully with `npm run build`.

## Current attribution

The original code did contain a real plugin-side race: Popout initialization
continued after the user could already have closed the native window. That
race is now guarded.

The error nevertheless persists during aggressive churn, and the renderer/CDP
disconnect occurred during the same run. This makes an Obsidian/Electron
window-teardown issue, possibly interacting with Excalidraw's own cleanup,
more likely than a single remaining `removeListener()` call in this plugin.

A known Electron-family failure mode also reports two or three `Uncaught
illegal access` messages while renderer resources are being torn down:

https://forum.obsidian.md/t/closing-new-window-while-sync-is-running-freezes-app/84957

## Follow-up

The next useful isolation step is to capture the Popout renderer's own CDP
target before close and install an `error` listener there. If the error stack
points into Obsidian or Excalidraw after the plugin callbacks have stopped,
the plugin should retain the guards as a workaround and report the remaining
issue upstream.
