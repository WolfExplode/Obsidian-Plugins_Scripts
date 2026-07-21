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

Status: **unresolved.** Read `excalidraw-pureref/docs/transparent-popout-investigation.md` before resuming. The checked-in host plugin contains no transparency implementation; experimental code exists only in the uncommitted-recovery copy.

Verified: a directly constructed transparent, frameless `BrowserWindow` can composite correctly on this machine. The tested main-process `setWindowOpenHandler` received tagged opens and honored frame, size, and a red background override, but the resulting Obsidian Popout still appeared opaque. Do not infer from the red probe that desktop alpha was honored.

Unknown: why the Obsidian child remained opaque and whether a fully editable transparent Popout is possible through that creation path. Untested candidates include shaping the existing Popout with `setShape`, adopting the child WebContents into a transparent `BaseWindow` with `WebContentsView`, and an independent live reference surface. ADR 0007 is proposed/blocked, not accepted.
