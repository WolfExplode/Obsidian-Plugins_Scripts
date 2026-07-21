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

Status: **paused and unresolved as of 2026-07-21.** Read `excalidraw-pureref/docs/transparent-popout-investigation.md` before resuming. The checked-in v10 F10 path is a reproducible diagnostic checkpoint, not a validated transparency implementation.

Verified: a directly constructed transparent, frameless `BrowserWindow` can composite correctly on this machine. The tested main-process `setWindowOpenHandler` received tagged opens and honored frame, size, and a red background override, but the resulting Obsidian Popout still appeared opaque. Do not infer from the red probe that desktop alpha was honored.

Native `setShape` was rejected because it clips content and removes hit-testing. v4 verified that inspected DOM layers and both canvas corners were transparent while the result remained dark. v6 produced a visibly transparent BaseWindow loading surface but failed Obsidian's BrowserWindow-owner assumption. v8 preserved editing/zoom/resize/RMB movement in a BrowserWindow but remained opaque. v9/v10 bridged the transparent BaseWindow into Obsidian's owner lookup and produced a fully editable Board, yet the initialized result remained opaque. v10 reapplied native/view transparency twice, intercepted zero background-color requests, and closed cleanly. The specific cause is still unknown; a non-alpha-capable adopted guest/compositor surface is only a hypothesis. An independent live reference surface remains untested. ADR 0007 is proposed/paused, not accepted.
