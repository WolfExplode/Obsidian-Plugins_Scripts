# Project Memory

## `excalidraw-pureref` build workflow

The Obsidian plugin executes the bundled `main.js`, compiled by esbuild from `src/*.ts`. After **every** edit under `excalidraw-pureref/src/`, run `npm run build` in `excalidraw-pureref` so Obsidian receives the updated bundle. Type-checking alone does not update the running plugin.

The repository's `.claude/settings.json` has a Claude-specific post-edit build hook, but do not assume it applies to Codex. To apply a rebuilt plugin in a running Obsidian instance, disable and then enable the `excalidraw-pureref` plugin using the Obsidian DevTools connection.

## Obsidian DevTools debugging

The `obsidian-devtools-mcp` project is in the repository root (gitignored). It connects through CDP on port 9222. Use `launch-obsidian-debug.ps1` (or its `.bat` wrapper) to quit Obsidian and relaunch it with remote debugging. Obsidian must have been launched with `--remote-debugging-port=9222`; launching normally from the tray/icon will not expose the port.

- The system-wide executable is `C:\Program Files\Obsidian\Obsidian.exe`.
- Confirm the debugging endpoint with `Invoke-RestMethod http://localhost:9222/json`.
- Connect before reproducing a bug: console capture starts only after the connection is established.
- Script evaluation is expression-based; do not use a bare `return`.
- If a server works in Claude CLI but not VS Code, check `.claude.json` project path casing (`C:/` vs `c:/`).

## Transparent, frameless popout work

Status: **partially unblocked; do not call it fully solved yet.** Read `excalidraw-pureref/docs/transparent-popout-investigation.md` before resuming. A direct `new remote.BrowserWindow({ transparent: true, frame: false })` renders transparently on this machine, and a focused probe proved that the `window.open` handler's `overrideBrowserWindowOptions` is honored (red 480×480 frameless result). Obsidian creates popouts through `window.open`.

The main-process `setWindowOpenHandler` path fires for tagged opens and honors at least `transparent`, `backgroundColor`, `frame`, and size overrides in the current session. The live plugin popout is frameless; desktop pixel transparency still needs a clean screenshot confirmation. Compare it against a direct transparent-window reference before declaring success.

Transparency is creation-only. Transparent-window compositing can be disrupted by a screen-capture/overlay/GPU utility; GPU itself was not the problem. The code remains behind the off-by-default `transparentBackground` setting. ADR 0007 is proposed/blocked, not accepted.
