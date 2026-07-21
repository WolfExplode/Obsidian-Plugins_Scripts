# Transparent Popout investigation

## Status

**Paused and unresolved as of 2026-07-21.** The checked-in host plugin contains the v10 F10-only diagnostic path. It is a reproducible research checkpoint, not a validated transparent Popout implementation. No tested native route has produced a surface that is simultaneously transparent, fully initialized by Obsidian, and editable. The v11 live-CDP investigation (same day) closed off the previously open "independently constructed BrowserWindow" question with an architectural finding, not a code experiment — see below. The only untried route now is an Obsidian `asar` patch at the original construction point.

The goal is a genuinely see-through Windows desktop surface: Board content remains visible while the space around it reveals other applications. Blur, Mica, Acrylic, uniform window opacity, and a merely transparent DOM are not equivalent.

## Confidence labels

- **Verified observation** — reproduced directly in the running application or on the desktop.
- **Interpretation** — an explanation consistent with observations but not yet proven.
- **Failed experiment** — an attempted route that did not produce a usable transparent Popout.
- **Untried candidate** — a plausible route identified in code or primary documentation but not tested in this project.

## Verified observations

1. A directly constructed `BrowserWindow` with `transparent: true`, `frame: false`, and an alpha background has rendered genuinely transparent on this machine.
2. Transparency could not be added successfully to an already-created opaque window with `setBackgroundColor("#00000000")`.
3. Obsidian creates its Popout through renderer `window.open("about:blank", ...)` and includes geometry and a theme background in the feature string.
4. `@electron/remote.require(<absolute path>)` can execute a helper in Electron's main process in the tested Obsidian build.
5. A main-process `setWindowOpenHandler` received the marker attached to the host plugin's tagged `window.open` call.
6. An override probe visibly changed the child window's frame, size, and red background. This proves those override fields were honored in that test; it does **not** prove that the `transparent` field produced desktop alpha.
7. The experimental Obsidian Popout remained an opaque dark rectangle even when its DOM layers and Excalidraw canvas were configured for transparency. Canvas corner pixels were inspected as RGBA `[0, 0, 0, 0]`.
8. Removing Obsidian's `background=...` feature did not make the experimental Popout transparent.
9. A plain HTML child using the same tagged `window.open` route was also opaque, so Excalidraw was not required to reproduce that failure.
10. A direct transparent control window worked in the same session while the handler-created Popout remained opaque.
11. GPU compositing reported as enabled. At another point, unrelated running software appeared to disrupt even direct transparent-window compositing; closing software restored it, but the interfering program was not identified.
12. The v3 `WebContentsView` experiment successfully created a frameless custom host, adopted and populated Obsidian's child WebContents, mounted the Excalidraw leaf, and rendered the editable Board without console errors. The surrounding Board background remained an opaque dark rectangle, so end-to-end transparency was not achieved.
13. The v4 trace found `viewBackgroundColor: "transparent"`, transparent computed backgrounds on every inspected Obsidian/Excalidraw layer, and RGBA `[0, 0, 0, 0]` at the corners of both canvases before and after the presentation-state update. The opaque rectangle therefore did not originate in any renderer layer that the trace inspected.
14. The v6 `BaseWindow` host was visibly transparent on the desktop and displayed Obsidian's initial loading word. The child reached `dom-ready` and `did-finish-load` for `about:blank`, then Obsidian's Popout construction failed while reading `getZoomFactor` from an undefined owner. This proves the native BaseWindow composition can be transparent, but it does not satisfy Obsidian's assumption that the child belongs to a `BrowserWindow` with its own `webContents`.
15. The v9/v10 compatibility bridge made `BrowserWindow.fromWebContents(adoptedChild)` return the BaseWindow and exposed the adopted child as its compatibility `webContents`. Obsidian then completed Popout initialization; the Board remained editable and supported zoom, resize, and RMB window movement.
16. In v10 the experimental BaseWindow's background setter was wrapped successfully, but no background-color request was intercepted. Native transparency was explicitly applied at host creation and reapplied after Excalidraw mounted; the child `WebContentsView` background was also reapplied as transparent. The fully initialized Board still appeared over an opaque dark rectangle in two observed runs.
17. The v10 close lifecycle completed `close` → `closed` → child destruction without the v9 main-process error dialog.
18. Live inspection (via CDP, 2026-07-21) of the real `WorkspaceWindow` constructor (`Workspace.prototype.openPopout`'s `O0` class) shows it unconditionally creates its window with `r.win = window.open("about:blank", "_blank", features)`, then builds the Popout's entire DOM and wiring by direct synchronous property access on the returned object: `u.document.body.createDiv(...)`, `u.history.forward = ...`, `u.addEventListener('focus'/'beforeunload'/'resize', ...)`, and reading `u.electron`/`u.electronWindow`/`u.app`. There is no code path that accepts an already-existing window in place of one `window.open` returns.
19. In the live main Obsidian window, `window.electron` (an object with `nativeImage`, `shell`, `clipboard`, `contextBridge`, `crashReporter`, `ipcRenderer`, `webFrame`, `webUtils`, `remote`) and `window.electronWindow` (an `@electron/remote`-style BrowserWindow proxy, keys including `setBounds`, `_browserViews`, `devToolsWebContents`) are present globally, not only on `window.open`-created children — these come from Obsidian's own preload, not from anything special about the `window.open` relationship.
20. A live popout's `window.open`-returned object (`win.win`) is a genuinely different JS realm from the opener (`win.win.Array !== window.Array`, `win.win.Object !== window.Object`, and its `document.body`'s prototype differs from the opener's), yet `win.doc.body.createDiv` — one of Obsidian's own DOM-prototype monkeypatches — is present and callable. Obsidian re-applies its patches into every new realm it creates (this is what one of the unlabeled helper calls in the constructor, `bm(u.document)`, does); the createDiv-style API is not evidence of a shared realm.

## Experiment boundary matrix

The phrase **directly constructed BrowserWindow** is easy to overread. In this document it means only that plugin code called `new BrowserWindow(...)`; it does not imply that a live Obsidian WorkspaceWindow was independently bootstrapped inside that window.

| Native host and content source | Bypasses `window.open` guest creation? | Live editable Obsidian Board? | Observed result |
| --- | --- | --- | --- |
| Direct `BrowserWindow` + simple test HTML | Yes | No | Transparent |
| Direct `BrowserWindow` + PNG snapshot of the Board | Yes | No; static image only | Transparent |
| Direct `BrowserWindow` inside `createWindow` + Electron-supplied guest WebContents | No; the guest was pre-created for `window.open` | Yes | Opaque |
| Direct `BrowserWindow` + adopted supplied guest in `WebContentsView` | No | Yes | Opaque |
| Direct `BaseWindow` + adopted supplied guest before Obsidian initialization | No | No; stopped at loading/owner failure | Transparent |
| Direct `BaseWindow` + compatibility bridge + fully initialized supplied guest | No | Yes | Opaque |
| Independently created `BrowserWindow` + independently bootstrapped live Obsidian WorkspaceWindow/leaf | **Yes** | Intended | **Not tried; no bootstrap method has been established** |
| Patch Obsidian so its own native-window/guest creation requests transparency at the original construction point | Intended | Intended | **Not tried** |

The final two rows are materially different from every live-board experiment completed so far. All completed live-board experiments still consumed the guest WebContents originating from Obsidian's `window.open("about:blank", ...)` path. Therefore the current evidence does **not** answer whether bypassing that guest creation entirely—or patching Obsidian at its original construction point—would fix compositing.

## Failed experiments

### Main-process window-open override

The recovery copy contains a main-process handler that requested `transparent`, an alpha `backgroundColor`, and `frame: false` for a tagged Obsidian child. The resulting editable Popout remained opaque. The implementation was removed from the checked-in code.

This result does not establish that `setWindowOpenHandler` can never work. It establishes only that the tested implementation and runtime state did not produce the required result.

### Custom `createWindow` host

A `createWindow` experiment preserved Electron's supplied `options.webContents` and still appeared opaque. Removing that WebContents caused Electron to reject the child as invalid. Experiments with nested transparency and a deprecated `BrowserView` produced a transparent native rectangle but no populated Obsidian document or Excalidraw leaf.

These results did not determine whether the failure came from the guest-window handshake, the chosen host type, option mutation, or another Obsidian/Electron interaction.

### Independently constructed BrowserWindow bypass — ruled out by live inspection (v11)

The plan going into this session was to construct a `BrowserWindow` with `transparent: true` set at construction (the one configuration verified working, observation #1) ourselves — bypassing `openPopoutLeaf()`/`window.open` entirely — and then bootstrap a real `WorkspaceWindow`/Excalidraw leaf into it by replicating what Obsidian's own constructor does. AGENTS.md had flagged this as the one route never tried.

Live inspection of the actual `WorkspaceWindow` constructor (observation #18) shows this is not viable as scoped. The constructor's entire DOM-building sequence — `u.document.body.createDiv(...)`, reassigning `u.history.forward`, `addEventListener` on `u` itself, etc. — is synchronous, direct property access on the object `window.open` returns to the *caller*. This is standard same-origin cross-window scripting, not an Electron-specific quirk, and it is only available for windows opened via `window.open` (or equivalent opener-relationship APIs) from the calling renderer. A `BrowserWindow` constructed independently in the main process has no such relationship to any renderer's `window` global; there is no supported way for renderer JS to obtain a live, synchronously-writable `Window`/`Document` reference to it. `@electron/remote` (used throughout v1–v10) only remotes specific main-process module surfaces (window bounds, focus, etc.), not arbitrary live DOM access to another renderer's document.

The `window.electron`/`window.electronWindow` globals the constructor reads (observation #19) are not the blocker — they come from Obsidian's own preload and could in principle be replicated on an independently created window. The blocker is structural: the *only* way to get the kind of live window reference `WorkspaceWindow`'s bootstrap requires is `window.open`, and that route was already tested in "Main-process window-open override" above — `transparent: true` requested via `setWindowOpenHandler` at the exact creation of that same window still composited opaque. There is no independent-construction variant left to try that avoids re-entering that already-failed path.

This closes the "independent bootstrap" question with an architectural finding rather than a build/run experiment — no plugin code was changed for this entry.

### Independent snapshot window

An F10 prototype created a directly constructed transparent window containing a PNG capture of the Excalidraw canvas. It demonstrated a possible reference surface, but it was a static snapshot rather than a live editable Board and did not make mode switching imperceptible. This was an architecture experiment, not an accepted product design.

### Independently bootstrap live Obsidian content — not tried

A proposed diagnostic is to call `new BrowserWindow({ transparent: true, ... })` independently, never invoke Obsidian's `window.open` Popout path, and initialize the same live WorkspaceWindow/Excalidraw Board inside it. This would directly test whether the decisive difference is who performs the original native window and guest-WebContents construction.

This is distinct from the transparent HTML controls, the PNG snapshot window, and every `createWindow`/adoption experiment. It has not been completed. The missing mechanism is how to bootstrap Obsidian's live WorkspaceWindow, application context, preload/remote setup, workspace events, and leaf lifecycle in an independently created WebContents. There is no established “same content” URL in the project that can simply be passed to `loadURL`. Treat this as a valuable untried diagnostic whose cost is currently uncertain, not as a cheap test already performed.

If this independent bootstrap works and is transparent, it would strengthen the case that the defect is confined to Obsidian's original `window.open` guest/window construction and that an Obsidian `asar` patch may be useful. If it remains opaque, an `asar` patch limited to native constructor flags would be less promising. Neither result has been observed.

## Interpretations that remain unproven

- The precise reason the fully initialized adopted child composites opaquely is unknown. The BrowserWindow's implicit WebContents explained a plausible extra layer in v4/v8, but v10 reproduced the opaque result in a BaseWindow with no implicit WebContents, so that explanation is insufficient.
- The earlier theory that `about:blank` makes the native surface opaque is not established. Electron documents the `about:blank` restriction for inherited **WebPreferences**; `transparent` and `frame` are `BrowserWindow` constructor options.
- v10 found no call to the experimental host's exposed `setBackgroundColor` method. This rules out that specific mutation path; it does not rule out other Obsidian, Electron, Chromium, or compositor state changes.
- A remaining interpretation is that the adopted guest WebContents or its compositor surface was not created with an alpha-capable backing store, even though its DOM, canvases, and enclosing `WebContentsView` all report transparency. This has not been proven.
- It is unknown whether an overlay/capture utility affected any of the plugin-window comparisons. Future tests should always include a direct transparent control in the same session.
- A fully editable transparent Obsidian Popout has not been proven possible or impossible.

## Candidate routes and current evidence

### Shape the existing Popout — rejected after live test

Electron's experimental `BaseWindow.setShape(rectangles)` was tested on the existing editable Popout. It behaved as documented: the window and its Board content were clipped to the supplied center rectangle, pixels outside it disappeared, mouse input fell through to the application behind, and the ordinary resize edges were no longer available.

This is native window cropping, not background transparency. A complex Board-derived shape could retain more content, but it would still remove hit-testing outside the shape and would not preserve a normal rectangular transparent input surface. The user confirmed those semantics are not the desired result, so this route is rejected.

### Adopt the child WebContents into a transparent host — partially validated

Current Electron documentation says `WebContentsView` can adopt an existing WebContents and that a transparent native host requires its child view background to be transparent too. The recovery experiment used deprecated `BrowserView`, not `WebContentsView`.

An initial F10 run created hosts but the adopted child repeatedly raised `Uncaught illegal access`; helper loading also reported that `@electron/remote` was disabled for the invoking WebContents. This did not test transparency successfully because Obsidian's inherited preload depends on that bridge.

The second run did not reach child adoption: the external helper could not resolve `@electron/remote/main` by package name because Obsidian bundles it inside `app.asar`, outside the plugin helper's normal Node resolution ancestry.

The v3 helper reused Obsidian's already-loaded remote main server from the main-process module cache and enabled remote access for the adopted child. Live observation proved that the child-window handshake, document population, Excalidraw mounting, and Board rendering survive WebContentsView adoption.

The v4 structured trace then ruled out the inspected DOM and canvas layers as the source of the dark rectangle. That result exposes a previously overlooked distinction: a `BrowserWindow` always owns its own WebContents in addition to the adopted child view.

The v5 experiment replaced the `BrowserWindow` host with a `BaseWindow`. Electron documents `BaseWindow` as a window intended for composing `WebContentsView` instances; it does not create an automatic WebContents. A stale destroyed host wrapper remained in the helper registry after an earlier attempt, and the startup diagnostic snapshot threw while inspecting it. The supplied v5 traces therefore did not reach creation of a new test window and establish nothing about the transparency result.

The v6 experiment kept the same `BaseWindow` architecture with exception-safe diagnostics. It produced a truly transparent native surface, but Obsidian aborted Popout initialization at `getZoomFactor` because a `BaseWindow` intentionally has no owned `webContents`.

The v7 experiment returned to the Obsidian-compatible `BrowserWindow` host, but incorrectly called `setBackgroundColor` on its implicit WebContents. Electron exposes no such WebContents method, so the handler raised an uncaught main-process `TypeError` before completing host creation. This run established no transparency result.

The v8 experiment successfully called the documented `View.setBackgroundColor("#00000000")` on the BrowserWindow's root `contentView`; the runtime object was a `View` and exposed the setter. The full editable Board loaded, zooming worked, the window resized, and RMB dragging repositioned it. Despite the transparent root view, transparent adopted child view, transparent inspected DOM layers, and transparent canvas corners, the desktop result remained an opaque dark rectangle. This route did not control the BrowserWindow's implicit renderer backplate.

The v9 experiment returned to the BaseWindow and added a narrow compatibility bridge for Obsidian's owner assumption. Both the `BrowserWindow.fromWebContents` mapping and compatibility `webContents` property were verified in the trace. Obsidian then completed initialization and displayed the editable Board, proving the bridge works, but the final surface was again opaque. Closing also raised a main-process error because a generic `closed` logger read `host.id` from the already-destroyed native wrapper.

The v10 experiment captured primitive IDs for safe lifecycle logging, intercepted background-color requests on only the experimental BaseWindow, and reasserted both native-window and child-view transparency after Excalidraw mounted. No background request was intercepted, close cleanup succeeded, and the visual result remained opaque. This falsified the specific hypothesis that Obsidian was making the BaseWindow opaque through the exposed `setBackgroundColor` method.

### Independent live reference surface

A directly created transparent window is known to composite correctly. It could display a live representation of the Board and switch to the editable Popout on demand. This is a fallback candidate, not an accepted design, and it must preserve geometry and framing well enough that a user cannot perceive a window replacement.

## Questions for a future session

- Determine whether Electron exposes any supported way to create or convert the supplied guest WebContents with an alpha-capable compositor surface before adoption.
- Capture the visual/compositor transition between the transparent v6 loading surface and the opaque fully initialized v10 Board, ideally with a same-session transparent control.
- Reassess whether a separately constructed live reference surface can meet the user's requirement that switching to editing be visually imperceptible. This remains a fallback, not an accepted design.
- Re-test against future Obsidian/Electron versions before concluding the limitation is permanent.

The only remaining untried route (per v11's finding above) is an Obsidian `asar` patch at `WorkspaceWindow`'s actual construction point — i.e. editing Obsidian's own bundled code so the `window.open(...)` call it makes requests `transparent`/`frame: false` options that are honored *before* any content loads, rather than intercepting the request externally the way `setWindowOpenHandler` does. This is a different intervention point than anything tested so far: every prior attempt (including the failed `setWindowOpenHandler` override) worked from outside Obsidian's own construction call, at or after the point Electron had already committed to whatever compositor surface it was going to create. Whether patching from inside actually changes that outcome is still unknown and unproven.

### Reassessment of the `asar` patch route (2026-07-21, no code run)

This route is downgraded from "one untried candidate" to "probably not worth pursuing," for two reasons found on discussion, neither requiring a new experiment to state:

1. **The intervention point is likely identical to the already-failed one, not a different one.** Electron's `setWindowOpenHandler` exists precisely so a caller outside the `window.open` call site can inject `overrideBrowserWindowOptions` — including `transparent`/`frame` — at the same point in Electron's native window-creation pipeline that the callee's own constructor options would have taken effect. The "Main-process window-open override" experiment above already delivered `transparent: true` at that point and still composited opaque. Patching Obsidian's bundled source to pass the same flag one call-site earlier is not obviously a different point in Electron's pipeline — it is more likely to reproduce the same opaque result than to bypass it. The framing in this document (and in ADR 0007) that this is "a different intervention point than anything tested so far" has not been substantiated and should not be treated as a reason for optimism.
2. **Even if it did work, it is not durably deployable.** Obsidian auto-updates by default, and its bundle is minified/renamed per build (observation #18's `O0` class naming). A patch keyed to that code would need re-derivation or re-verification every release, plus a mechanism to reapply the patch to `app.asar` after each auto-update — there is no clean hook for this short of wrapping the installer or disabling auto-update, which is an ongoing cost larger than the fragility concern alone would suggest.

Net: treat the `asar` patch as a low-expected-value experiment, not the natural next step. The independent live reference/snapshot surface (see "Independent live reference surface" above) is the more realistic path forward if transparency remains a goal.

Do not describe transparency as solved until the user visibly confirms that another application is present through the Popout's unused regions.
