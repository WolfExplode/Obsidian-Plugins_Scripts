# Transparent Popout investigation

## Status

**Paused and unresolved as of 2026-07-21.** The checked-in host plugin contains the v10 F10-only diagnostic path. It is a reproducible research checkpoint, not a validated transparent Popout implementation. No tested native route has produced a surface that is simultaneously transparent, fully initialized by Obsidian, and editable.

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

## Failed experiments

### Main-process window-open override

The recovery copy contains a main-process handler that requested `transparent`, an alpha `backgroundColor`, and `frame: false` for a tagged Obsidian child. The resulting editable Popout remained opaque. The implementation was removed from the checked-in code.

This result does not establish that `setWindowOpenHandler` can never work. It establishes only that the tested implementation and runtime state did not produce the required result.

### Custom `createWindow` host

A `createWindow` experiment preserved Electron's supplied `options.webContents` and still appeared opaque. Removing that WebContents caused Electron to reject the child as invalid. Experiments with nested transparency and a deprecated `BrowserView` produced a transparent native rectangle but no populated Obsidian document or Excalidraw leaf.

These results did not determine whether the failure came from the guest-window handshake, the chosen host type, option mutation, or another Obsidian/Electron interaction.

### Independent snapshot window

An F10 prototype created a directly constructed transparent window containing a PNG capture of the Excalidraw canvas. It demonstrated a possible reference surface, but it was a static snapshot rather than a live editable Board and did not make mode switching imperceptible. This was an architecture experiment, not an accepted product design.

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

Do not describe transparency as solved until the user visibly confirms that another application is present through the Popout's unused regions.
