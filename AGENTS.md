# Project Memory

## Where to look first

This file covers how to build, test, and debug the plugin. It is not the whole
record.

- [CONTEXT.md](CONTEXT.md) — the project's vocabulary. Board, Popout, host plugin,
  and Excalidraw canvas are defined terms with names this project deliberately
  avoids. Use them in code, comments, and commit messages.
- [docs/README.md](docs/README.md) — routes to behavior guides, integration
  contracts, ADRs, and investigations by intent. Read the relevant guide before
  changing code that crosses an Obsidian, Excalidraw, or Electron boundary; an
  ADR before changing architecture or scope. Investigations record evidence and
  rejected routes — they are not accepted plans.

## `excalidraw-pureref` build workflow

The Obsidian plugin executes the bundled `main.js`, compiled by esbuild from `src/*.ts`. Type-checking alone does not update the running plugin, and a stale bundle fails **silently** — it looks exactly like "the fix didn't work."

**Run `npm run verify` before treating any change as done.** It chains typecheck →
production bundle → `verify-build.mjs` → the test suite, so one clean run (~2s)
means the bundle is current and the pure geometry still passes.

Do this once, when the work is finished — not after every intermediate edit. A
multi-edit refactor passes through broken states by design, and building through
them tells you nothing.

The repository's `.claude/settings.json` has a Claude-specific `Stop` hook that
runs `npm run verify` as a backstop when a source file is newer than `main.js`.
Do not assume it applies to Codex, and do not rely on it in place of running
verify yourself.

## Obsidian DevTools debugging

The `obsidian-devtools-mcp` server (in the repository root, gitignored) connects
to Obsidian over CDP on port 9222 to read the console, evaluate script, and reload
the plugin.

**Obsidian must have been launched with `--remote-debugging-port=9222`.** Starting
it normally from the tray or icon does not open the port, and every tool then
fails. `launch-obsidian-debug.ps1` (or its `.bat` wrapper) quits a running
Obsidian and relaunches it with the flag; the system-wide executable is
`C:\Program Files\Obsidian\Obsidian.exe`. Confirm the endpoint with
`Invoke-RestMethod http://localhost:9222/json`.

- **Connect before reproducing.** Console capture starts at connect — anything
  logged earlier is not retrievable.
- **Script evaluation is expression-based.** A bare `return` is a SyntaxError;
  end with the value instead.
- If a server works in the Claude CLI but its tools are missing in VS Code, check
  `.claude.json` project path casing (`C:/` vs `c:/`).

## What a plugin reload does not reload

To apply a rebuilt plugin in a running Obsidian instance, disable and then enable
`excalidraw-pureref` through the Obsidian DevTools connection. That cycle re-runs
renderer code for windows created after it. Two categories fall outside that, and
both fail the same silent way — the rebuilt `main.js` is correct, but the running
app keeps the old behavior, which is indistinguishable from "the fix didn't work."

- **Main-process `.cjs` helpers.** `transparent-proto.cjs` is loaded through
  `@electron/remote.require` and lives in the *main* process require cache, which
  a renderer-side reload never clears. It self-evicts: the helper exports
  `__evictFromCache()` (`delete require.cache[__filename]`, which runs in main,
  where the deletion actually takes effect) and `src/transparent-proto.ts` calls
  it on the stale module before re-requiring. Ordinary `.cjs` edits therefore do
  apply on reload — but a change to the eviction machinery itself cannot bootstrap
  itself, and needs one full Obsidian restart.
- **Handlers attached to an already-open Popout**, such as
  `src/popout-drop-bridge.ts`. The Popout document outlives the reload and the
  window-open/finalize timing desyncs, so re-attachment is unreliable. Restart
  Obsidian (`launch-obsidian-debug.ps1`) when testing Popout-window handler
  changes rather than trusting a reload.

Do not confirm main-process state by reading it back through the
`@electron/remote` proxy — it returns stale snapshots and proxy stubs, and has
produced false negatives. Verify functionally instead: change an exported value,
reload, read it back.

Note also that `.cjs` and `.html` assets are not bundled by esbuild. They must sit
next to `main.js` in the plugin directory (the repository root) to resolve through
`manifest.dir` at runtime.

## Reproducing bugs: use a listener, not synthetic input

Do not reproduce a live-app bug — a timing race, event ordering, "this only
happens when the user does X" — by driving Obsidian yourself with scripted
actions through the DevTools connection. Synthetic reproduction can look
successful while silently testing something else.

Two ways it has already misled us. A plugin reload leaves shared in-memory state
primed from an earlier attach, so a "clean" scripted re-open of the same Board no
longer exercises the race at all; and heavy Boards load over *minutes*, which a
scripted `setTimeout(..., 2000)` never waits for. The image and video native-size
correctors' "pre-existing media gets resized" bug (2026-07-23/24) survived a
scripted repro that came back clean, and was only root-caused once the user was
asked to navigate the vault normally with verbose logging on.

Instead: turn on the relevant verbose/debug flag or attach a log hook, clear the
console buffer, then ask the user to reproduce the problem through normal usage,
and read the logs afterward. Reserve scripted evaluation for state inspection and
for confirming a fix applied — not for producing the failure.

## Avoid timers as bug fixes

Don't fix a race by adding a wall-clock wait (a debounce, a settle delay, a
retry backoff tuned by feel). A timer papers over an assumption about timing
you haven't actually verified, and a value picked to work on one machine's
observed timing is not a proof it holds elsewhere — it just moves the race
somewhere less frequent and harder to reproduce.

Before reaching for a timer, find the actual data condition the fix depends
on and poll or check *that* instead. Concrete case: the Popout "stuck loading
scene" fix (`finalizeCanvasWhenReady` in `src/popout-manager.ts`) first shipped
with a 300ms settle window before trusting a "canvas ready" reading, on the
assumption that Excalidraw's scene elements might populate a beat after its
API does. A live repro (2026-07-29, MCP-attached listener per the section
above) disproved that assumption — elements were fully populated the instant
the API existed, every time — so the 300ms was pure guesswork riding on top of
a condition that was already checkable directly. It was replaced with
`hasUnloadedFiles()`, a direct comparison between scene elements and
`getFiles()`, and the timer was deleted outright rather than kept as a
belt-and-suspenders margin.

If a timer still seems unavoidable after that search, say so and explain what
data condition isn't observable — don't add one silently as the default move.

## Watching Excalidraw scene changes

Anything that needs to react to scene changes across the main window and every
Popout goes through `attachPerLeafScanner` in `src/leaf-scanner.ts` — do not
hand-roll another attach/prune/reconcile loop. Supply `setup` (build per-leaf
state once the view's API is mounted and its saved scene has loaded) and `scan`
(runs on every change); the shared module owns leaf discovery, the mount-retry,
teardown, and the `isDestroyed` property-vs-method trap that silently broke
Popout support once already. `video-aspect.ts` and `media-auto-pack.ts` are
the consumers.

**Obsidian `EventRef`s must be released on the emitter they were registered on.**
`Vault` and `Workspace` are separate `Events` instances, so `workspace.offref(vaultRef)`
silently does nothing and leaks the listener on every plugin reload — verified
live: the pre-consolidation code grew one orphaned vault `create` and `delete`
handler per disable/enable cycle. Use the `onEvent(emitter, register)` helper,
which returns a disposer bound to the right emitter.

## Tests

`npm test` (also run by `npm run verify`) bundles `tests/*.test.ts` with the
esbuild that already builds the plugin, then runs them under `node --test`. No
test framework is installed and none should be added — `tests/run.mjs` is the
whole harness.

Only modules with no runtime `obsidian` import can be exercised by this harness.
Keep independently testable arithmetic in dependency-free modules.

## Reference material (local-only, NOT in git — read before guessing about Excalidraw)

`reference/` holds local copies of upstream sources so agents can look things up
directly instead of relying on web search or memory.

**It is gitignored and will be absent from a fresh clone.** At ~765 MB of vendored
upstream repositories it is deliberately not checked in. Before relying on anything
below, confirm the directory exists (`ls reference/`); if it does not, you are on a
machine that has never populated it, and these paths will not resolve. Re-clone the
upstream repos into `reference/` under the directory names below to restore it.

The contents:

- `reference/excalidraw-master/` — the full Excalidraw repo; use it as ground truth for core behavior, app state, and internals.
- `reference/obsidian-excalidraw-plugin-master/` — the full Obsidian Excalidraw community plugin repo; use it for the Obsidian integration layer. Two anchors worth knowing: `ExcalidrawView.semaphores` (incl. `justLoaded`, set and cleared around loading the saved scene) and `ExcalidrawData.scene`, the on-disk scene parsed synchronously at load. The latter is the reliable way to tell "this was saved in the file" from "this is on screen right now", and is what the native-size correctors' persisted-seed logic rests on (`getPersistedImageSeed` / `getPersistedEmbeddableSeed`).
- `reference/excalidraw-docs/` — Excalidraw / ExcalidrawAutomate documentation, including `ExcalidrawAutomate full library for LLM training.md` and `source-mdx/`. Use for the Obsidian plugin's scripting/automation API.
- `reference/PureRef-format-main/` — PureRef file-format reference.
- `reference/obsidian-synaptic-hatch-master/`, `reference/obsidian-ui-tweaker-master/` — other Obsidian plugins kept for reference/patterns.

When answering questions about Excalidraw internals, grep/read these local copies first.

