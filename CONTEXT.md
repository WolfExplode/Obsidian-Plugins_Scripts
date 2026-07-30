# Excalidraw-PureRef

An Obsidian plugin that recreates and extends PureRef's reference-board workflow by combining Obsidian windows with Excalidraw Boards.

## Language

**Host plugin**:
The standalone Obsidian plugin being built in this repository.
_Avoid_: Excalidraw plugin (that name belongs to the third-party dependency)

**Board**:
A single `.excalidraw` file used as a PureRef-style surface for freely arranged reference images.
_Avoid_: Scene (conflicts with Excalidraw's scene model), Canvas (conflicts with Obsidian Canvas)

**Excalidraw canvas**:
The rendering surface and element model supplied by the third-party Excalidraw community plugin.
_Avoid_: Excalidraw plugin (when referring only to its drawing surface)

**Front-of-embed rendering**:
The host plugin's behavior of making a non-embeddable element (an image, a drawn shape, text) visually appear in front of an embeddable element it overlaps, driven by the same scene z-order that Bring to Front/Send to Back already control. Works around Excalidraw rendering embeddables above everything else regardless of z-order — on its canvas, and again in its SVG export. One name, one candidate set, two mechanisms: the editable surfaces mask and blit the canvas, the read-only window stacks a second clipped export.
_Avoid_: Overlay (already means the separate transparent Popout surface in this project), always-on-top layer

**Popout**:
An always-on-top secondary OS window that presents exactly one Board. A Popout is distinct from the Board's view in the main Obsidian window.
_Avoid_: Window (too generic), tab, PureRef mode

**Popout opacity**:
The overall visibility of a Popout as a single surface, including its Board and every visual element inside it. It is independent of an individual image or drawing element's opacity.

**Plugin settings tab**:
The host plugin's entry in Obsidian Settings.
_Avoid_: Options panel, preferences

**PureRef interchange**:
Conversion between a Board's `.excalidraw` file and PureRef's `.pur` format. The Board remains the editable source of truth; a `.pur` file is an import or export artifact.
_Avoid_: Save format, native format (when referring to `.pur`), one-way conversion
