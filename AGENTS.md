# Project Memory

## `excalidraw-pureref` build workflow

The Obsidian plugin executes the bundled `main.js`, compiled by esbuild from `src/*.ts`. After **every** edit under `src/`, run `npm run build` in the repository root so Obsidian receives the updated bundle. Type-checking alone does not update the running plugin.

The repository's `.claude/settings.json` has a Claude-specific post-edit build hook, but do not assume it applies to Codex. To apply a rebuilt plugin in a running Obsidian instance, disable and then enable the `excalidraw-pureref` plugin using the Obsidian DevTools connection.

## Reference material (checked in — read before guessing about Excalidraw)

`reference/` holds local copies of upstream sources so agents can look things up directly instead of relying on web search or memory:

- `reference/excalidraw-master/` — the **full Excalidraw repo** (the `main`/master branch). Use this as ground truth for core Excalidraw behavior, appState fields, and internals. E.g. box-selection mode is `appState.boxSelectionMode: "contain" | "overlap"` (default `"contain"`; `"overlap"` = select-anything-the-box-touches, the PureRef-style behavior) — defined in `packages/excalidraw/appState.ts`. This feature is shipped on Excalidraw main and confirmed present in the user's Excalidraw.
- `reference/obsidian-excalidraw-plugin-master/` — the **full Obsidian Excalidraw community plugin repo** (not core Excalidraw — the Obsidian integration layer: `ExcalidrawView.ts`, `ExcalidrawData.ts`, `EmbeddedFileLoader.ts`, etc.). Use this for anything about how the Obsidian plugin loads/saves/wraps a Board that isn't explained by core Excalidraw alone — e.g. `ExcalidrawView`'s `semaphores` (incl. `justLoaded`, set/cleared around `loadDrawing`/`onChange` to mark "just finished loading the saved scene"), or `ExcalidrawData.scene` (the parsed on-disk scene from `JSON.parse`, populated synchronously at load — independent of whatever the live imperative API currently holds, and the reliable way to tell "was this saved to the file" from "is this on screen right now"). This was essential to correctly root-causing the image/video native-size correctors' pre-existing-media bug (see image-scale.ts / video-aspect.ts `getPersistedImageSeed` / `getPersistedEmbeddableSeed`).
- `reference/excalidraw-docs/` — Excalidraw / ExcalidrawAutomate documentation, including `ExcalidrawAutomate full library for LLM training.md` and `source-mdx/`. Use for the Obsidian plugin's scripting/automation API.
- `reference/PureRef-format-main/` — PureRef file-format reference.
- `reference/obsidian-synaptic-hatch-master/`, `reference/obsidian-ui-tweaker-master/` — other Obsidian plugins kept for reference/patterns.

When answering questions about Excalidraw internals, grep/read these local copies first.

## Reproducing bugs: use a listener, not synthetic input

Do not try to reproduce a live-app bug (timing races, UI event ordering, "this only happens when the user does X") by driving the app yourself through the Obsidian DevTools MCP with synthetic actions — scripted `openFile`/`detach`/`setTimeout` sequences, fake clicks, etc. Synthetic reproduction attempts can look successful while silently testing the wrong thing: e.g. a plugin-reload can leave shared in-memory state (like a `resolvedFileIds` Set) primed from an earlier attach, so a "clean" scripted re-open no longer exercises the real race at all — and heavy/streaming boards can take minutes to reveal timing issues that a scripted `setTimeout(..., 2000)` won't wait for.

Instead: attach a live listener/log hook (e.g. flip on the corrector's own `verbose` debug flag and read logs via `obsidian_get_console_logs`), then explicitly ask the user to reproduce the issue themselves by using the app normally. Real usage surfaces real timing and ordering that scripted reproduction reliably misses. This is how the image-scale/video-aspect "pre-existing images get resized" bug was actually root-caused on 2026-07-23/24 — an automated scripted re-open looked clean, but asking the user to navigate the vault live revealed images were still being incorrectly resized in slow bursts minutes apart.

## Generated image integration

Before changing any code that creates a vault image or changes an Excalidraw
image element's `fileId`, read
`docs/integrations/obsidian-excalidraw-generated-images.md`. Obsidian's vault,
ExcalidrawData, Excalidraw core, and persisted Board state each own a different
part of the lifecycle; changing their registration order can break either
immediate rendering or reload persistence.

## Obsidian DevTools debugging

The `obsidian-devtools-mcp` project is in the repository root (gitignored). It connects through CDP on port 9222. Use `launch-obsidian-debug.ps1` (or its `.bat` wrapper) to quit Obsidian and relaunch it with remote debugging. Obsidian must have been launched with `--remote-debugging-port=9222`; launching normally from the tray/icon will not expose the port.

- The system-wide executable is `C:\Program Files\Obsidian\Obsidian.exe`.
- Confirm the debugging endpoint with `Invoke-RestMethod http://localhost:9222/json`.
- Connect before reproducing a bug: console capture starts only after the connection is established.
- Script evaluation is expression-based; do not use a bare `return`.
- If a server works in Claude CLI but not VS Code, check `.claude.json` project path casing (`C:/` vs `c:/`).

## Transparent Popout work

The transparent editable-Popout route is paused. Before resuming it, read
`docs/investigations/transparent-popout-investigation.md` and ADR 0007. The
investigation is the canonical record of dated observations and experiments;
do not treat it as an accepted implementation plan.
