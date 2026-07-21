# Transparent Popout investigation

## Status

**Unresolved.** The checked-in host plugin does not currently implement transparent Popouts. Failed experimental code survives only in the uncommitted-recovery copy and should be treated as evidence, not as a working design.

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

- The precise reason the tagged Obsidian child remained opaque is unknown.
- The earlier theory that `about:blank` makes the native surface opaque is not established. Electron documents the `about:blank` restriction for inherited **WebPreferences**; `transparent` and `frame` are `BrowserWindow` constructor options.
- It is unknown whether Obsidian or Electron changes a relevant property after the handler returns.
- It is unknown whether an overlay/capture utility affected any of the plugin-window comparisons. Future tests should always include a direct transparent control in the same session.
- A fully editable transparent Obsidian Popout has not been proven possible or impossible.

## Untried candidates

### Shape the existing Popout

Electron exposes experimental `BaseWindow.setShape(rectangles)` support on Windows. Outside the supplied regions, Electron documents that pixels are not drawn and mouse events fall through. Applying and clearing a native shape at runtime could preserve the same editable Obsidian Popout while making unused regions absent.

Open questions include visual quality at antialiased or partially transparent edges, rectangle-count limits, performance while the Board camera changes, and the loss of background hit targets outside the shape.

### Adopt the child WebContents into a transparent BaseWindow

Current Electron documentation says `WebContentsView` can adopt an existing WebContents and that a transparent `BaseWindow` requires its child view background to be transparent too. The recovery experiment used deprecated `BrowserView`, not `WebContentsView`. A focused test may determine whether the newer host preserves Obsidian's child-window handshake.

This route is still speculative and may reproduce the same empty-document failure.

### Independent live reference surface

A directly created transparent window is known to composite correctly. It could display a live representation of the Board and switch to the editable Popout on demand. This is a fallback candidate, not an accepted design, and it must preserve geometry and framing well enough that a user cannot perceive a window replacement.

## Recommended next experiment

Test `setShape` on the existing Popout with a few large rectangles and compare it visually against a direct transparent control in the same desktop session. This is the smallest experiment that can disprove or justify the most native unexplored route without rebuilding the failed window-open architecture.

Do not describe transparency as solved until the user visibly confirms that another application is present through the Popout's unused regions.
