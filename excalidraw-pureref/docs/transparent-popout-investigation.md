# Transparent Popout — investigation status (paused)

Goal: make the F11 Popout a genuinely see-through, frameless OS window (PureRef's signature look) so the board's images float over whatever is behind the window.

Status: **native transparency failure isolated to the Obsidian `window.open` path.** The live plugin popout is frameless, but remains a solid dark rectangle even when both the DOM and Excalidraw canvas contain transparent pixels. A directly constructed transparent `BrowserWindow` composites correctly on the same desktop. The next experiment removes Obsidian's inherited `background=...` feature from the tagged open.

## What we know for sure (reproduced live via CDP + desktop screenshots)

1. **Direct construction works.** `new remote.BrowserWindow({ transparent: true, frame: false, backgroundColor: '#00000000' })` renders a genuinely see-through, frameless window on this exact machine, and normal DOM content (a colored `<div>`) composites correctly over the desktop. Proven twice: a red square over YouTube (session start) and, side-by-side, a pink square that was see-through in a `transparent` window vs. the same square on a solid fill in an `opaque` window (after unrelated software was closed).
2. **Transparency is creation-only.** `setBackgroundColor('#00000000')` on an already-created opaque window collapses to `#000000`. Cannot be retrofitted.
3. **Obsidian creates popouts from the renderer** via `window.open("about:blank", "_blank", features)` inside the `WorkspaceWindow` constructor. It appends `background=<theme color>` (e.g. `#1c2127`) and `x/y/width/height` to the features string. `window.open` is a patchable renderer global (unlike the cached `BrowserWindow` constructor).
4. **`@electron/remote.require(<abs path>)` runs a module in the MAIN process** (verified: inside it `process.type === "browser"` and pid ≠ renderer pid). This is a real way to install a synchronous, main-resident `setWindowOpenHandler`.
5. **A renderer-installed `setWindowOpenHandler` breaks `window.open`** (returns `null`) — the handler must return synchronously in main, which a remote-bridged renderer callback can't. Main-resident handler avoids this.
6. **The main-resident handler DOES fire** for our tagged `window.open` calls — a debug recorder captured `details.features` containing our marker.
7. **The earlier framed/opaque result was not reproducible as a definitive Electron limitation.** A focused `override-probe` returned `{ transparent:true, backgroundColor:'#FF0000', frame:false, width:480, height:480 }`; the resulting windows had a red background, exact 480×480 bounds, and identical content/bounds (frameless). The live plugin popout likewise had identical content/bounds. This proves that `overrideBrowserWindowOptions` is honored at least for these options in the current session. Desktop pixel transparency still needs a clean screenshot-based confirmation.
8. **Transparent-window compositing is sensitive to other running software.** At one point even *direct* transparent windows stopped compositing their content; after the user closed some unnamed app, direct transparent windows worked again. Identify/avoid that app during future testing (likely a screen-capture / overlay / GPU-hooking tool).
9. GPU is healthy (`getGPUFeatureStatus().gpu_compositing === "enabled"`); a full PC restart is probably NOT required.
10. Excalidraw's `<canvas>` content renders fine in an opaque popout (board images showed), so the canvas itself is not the blocker — the window never became transparent in the first place.
11. **Grid removal does not solve the failure.** In the live popout, `viewBackgroundColor` was already `transparent`; temporarily setting `gridSize: 0` and `gridModeEnabled: false` removed the grid state, but the desktop screenshot still showed a solid dark rectangle around the board. Inspecting both Excalidraw canvases showed transparent corner pixels (`RGBA [0, 0, 0, 0]`).
12. **A direct control window works in the same session.** A temporary `new BrowserWindow({ transparent: true, frame: false, backgroundColor: '#00000000' })` with red text was visibly composited over the user's white second-monitor background. The plugin popout beside it remained opaque. This rules out a machine-wide Electron/Windows compositor failure.
13. **Removing Obsidian's `background=...` feature did not fix the plugin popout.** The renderer patch was changed to remove the token before appending the marker, rebuilt, and tested after a full Obsidian restart. The popout remained opaque.
14. **A plain HTML child created through the same main-process handler is also opaque.** This control contains no Excalidraw, canvas, or Obsidian view DOM, yet it did not show through the white monitor. The failure is therefore in the `window.open` creation path, not Excalidraw rendering.
15. **The `createWindow` fallback is not solved yet.** Electron 37 documents `createWindow` as the full-control replacement for the default `window.open` BrowserWindow construction. We added a fallback that manually constructs a transparent child with inherited options, rebuilt, and restarted Obsidian so the main-process helper was freshly loaded. The resulting plugin popout still appeared opaque. This may mean the callback is not being used by this guest-window path, or that the inherited options/child attachment require additional handling.
16. **The `createWindow` contract requires the supplied `options.webContents`.** A follow-up attempt that removed that field to sanitize the inherited options caused Electron's main-process error: `Invalid webContents. Created window should be connected to webContents passed with options object.` This invalid attempt was removed. The valid earlier attempt preserved `webContents` and remained opaque, so the issue is not solved by simply stripping the nested preference keys.
17. **Nested guest transparency can create a genuinely transparent host, but not a working Obsidian popout.** Setting both top-level and nested `transparent`/alpha options produced the invisible, borderless rectangle the user could resize. Its document remained empty (`about:blank`, no body/canvas), and no Excalidraw leaf registered. Hosting the supplied WebContents in a BrowserView produced the same empty result. This proves the native alpha path works, while the `WorkspaceWindow` WindowProxy/content attachment path is what fails.

## Web research findings (Electron 37 / current documentation)

Electron's current `window.open` documentation adds an important constraint: when the URL is `about:blank`, the child WebContents preferences are copied from the parent, and Chromium skips the browser-side navigation that would normally allow them to be overridden. Electron also says that `setWindowOpenHandler` has final precedence for BrowserWindow constructor options, but this does not necessarily replace the already-created `about:blank` WebContents.

This fits the live evidence unusually well:

- Obsidian's `WorkspaceWindow` calls `window.open("about:blank", ...)`.
- The main handler receives the marker and `createWindow` is invoked.
- `createWindow` receives a pre-created `options.webContents`; omitting it throws Electron's contract error.
- The valid manually-created child remains opaque despite top-level `transparent: true`.

The current working theory is therefore that native transparency is being decided on the pre-created `about:blank` WebContents/native surface before the plugin's BrowserWindow override can affect it. This is an Electron/Obsidian guest-window integration limitation, not an Excalidraw canvas-background problem.

## Resolved contradiction

The handler path is partially effective: it creates a frameless window, but the resulting plugin window is still opaque. The earlier apparent success was likely a directly constructed control window or an attribution/state mistake. The current evidence is stronger because the plugin and direct control were compared on the same desktop session, with the same compositor state.

## Leading theories (most to least likely)

1. **The plugin's patched `window.open` may not be the call that creates the guest window.** The live plugin still reports Obsidian's theme background after the feature-stripping experiment, so the marker/feature transformation needs direct recording at the main-process handler boundary.
2. **Electron's guest-window path may ignore transparency-specific options in this Obsidian build.** `frame:false`/frameless appearance is not sufficient evidence that the helper's transparency override was applied; Obsidian may already be frameless in this session.
3. **The `createWindow` API's pre-created WebContents cannot currently be re-hosted without breaking Obsidian's WindowProxy handshake.** Nested transparency creates the native alpha surface, but Obsidian never populates the resulting document. The remaining viable options are an earlier guest-window construction hook or a pre-created transparent BrowserWindow integrated with Obsidian's expected WindowProxy.
4. Compositor/interfering-software state is now unlikely: a direct transparent control worked while the handler-created HTML control and plugin popout did not.

## NEXT STEP

The grid test, background-feature experiment, plain HTML handler control, and fresh-main-process `createWindow` experiment have now been completed. The next test should instrument the main-process handler and `createWindow` callback to record the exact feature string and callback usage, then use a conspicuous temporary native marker. Do not close this investigation as solved until the plugin window's surrounding desktop is visibly present through its transparent regions.

Definitively answering "is `overrideBrowserWindowOptions` honored at all?" collapses the theory space in one shot.

## If the handler path is dead — fallback directions (unexplored)

- Get Obsidian to adopt a **pre-created transparent BrowserWindow**: very hard — `WorkspaceWindow` expects `window.open` to return a live Window with `.document`/`.electronWindow`/`.electron` injected by the inherited preload; faking that is deep.
- **Patch the main-process `BrowserWindow` constructor** so the guest-window-manager's internal `new BrowserWindow(options)` gets `transparent:true`. Blocked by the same constructor-caching problem we already hit (guest-window-manager captures its `BrowserWindow` reference at module load).
- Investigate whether a newer/older Electron (i.e., a different Obsidian version) honors the override.

## Hybrid reference-mode prototype (current experiment)

The ordinary Obsidian guest Popout remains unsuitable as the transparent surface, so the plugin now has a separate F10 mode designed around that fact:

- **F10 from an Excalidraw board** creates an independent, frameless Electron `BrowserWindow`. It is born transparent, so it uses the direct creation path already proven to composite correctly on this machine.
- The window receives a PNG snapshot of Excalidraw's static canvas. The capture temporarily disables the grid for two render frames, then restores the board's prior grid state, so the reference display is grid-free without changing the editable board.
- The snapshot retains its source dimensions (no `object-fit: fill` stretching), has a 1px visible boundary, supports wheel zoom and **MMB pan**, and uses **RMB drag** to move the native window through a tightly-scoped IPC route.
- **F10 inside reference mode** closes that display window and reopens the ordinary fully-editable Excalidraw Popout. Editing therefore remains native Excalidraw; reference mode is only the transparent viewing surface.

This is a functional architecture test, not yet a finished PureRef implementation. It intentionally snapshots the board when switching modes; it does not live-sync edits while the reference window is open. User interaction is the authority for the transparent window's visibility and native drag behavior because a screenshot cannot reveal an empty transparent area reliably.

## Test harness notes (for next session)

- Obsidian must be launched with remote debugging (the repo's `launch-obsidian-debug.*` does this); connect via the obsidian-devtools MCP (`obsidian_connect`, port 9222).
- Screenshot a SINGLE monitor for clarity: PowerShell `System.Windows.Forms.Screen::AllScreens`, pick `.Primary` or the one with `Bounds.X < 0` (the user's left/portrait monitor), then `CopyFromScreen($b.X,$b.Y,0,0,$b.Size)`. Full-virtual-screen shots are cluttered and DPI-confusing (mixed 1.25-scale monitors).
- `setBounds` across monitors of different DPI remaps unexpectedly (see the DIP↔physical handling already in `src/electron.ts`); place test windows on the monitor you'll screenshot.
- `webContents.capturePage()` reflects the window's internally-rendered content, not screen compositing — useful but can mislead about actual transparency; trust the screen screenshot.
- Prototype/main helpers left in `scratchpad/`: `transparent-handler.js` (marker `epr-transparent`, has `install/uninstall/debug`), `override-probe.js` (marker `epr-ovr-probe`), `main-probe.js` (proves main-process execution).

## Current code state (all builds clean, behind an off-by-default setting)

- `electron-main-helper.cjs` — main-process helper: `begin(openerWindowId)`/`end(openerWindowId)` install/remove the tagged `setWindowOpenHandler`; temporary `createWindow`, BrowserView, and debug experiments were tested and removed.
- `src/transparent-window.ts` — `openTransparent(plugin, open)`: loads the helper via `remote.require`, brackets `openPopoutLeaf()` with the handler + a `window.open` marker patch.
- `src/popout-manager.ts` — opens via `openTransparent` when the setting is on; adds `epr-transparent` body class; forces Excalidraw `viewBackgroundColor` transparent on open and restores on close.
- `src/chrome-hider.ts` + `styles.css` — inline-enforced transparent backgrounds for every opaque layer incl. `.excalidraw-wrapper`, and hides the frameless `.titlebar`. (Note: Obsidian strips our body classes on re-render, so the inline path in chrome-hider is what actually carries; CSS is only a baseline.)
- `src/settings.ts` / `settings-tab.ts` / `main.ts` — `transparentBackground` setting (default off) + load/save.
- `docs/adr/0007-transparent-frameless-popout.md` — the intended design (supersedes ADR 0003). **Keep as proposed/blocked until transparency actually works.**

Known secondary bug: the on-close restore of `viewBackgroundColor` captured an already-transparent value during testing, so `WIP/Test.md`'s canvas background is currently persisted as `transparent`. Re-set it to the desired color when convenient.

