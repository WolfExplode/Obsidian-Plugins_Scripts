# Excalidraw interaction overrides

Excalidraw PureRef deliberately changes a small set of Excalidraw interactions
to support a reference-board workflow. These rules apply while the host plugin
is enabled, both in the normal Obsidian Excalidraw view and in an editable
PureRef Popout unless noted otherwise.

## Pointer gestures

| Gesture | Plugin behavior | Replaces or changes |
| --- | --- | --- |
| **Alt-drag** | Moves normally; it does **not** duplicate elements. | Excalidraw's built-in Alt-drag duplication is disabled. |
| **Alt+Shift-drag** with one or more images selected | Dominant left/right movement flips the selected images horizontally; dominant up/down movement flips them vertically. | Replaces the normal drag for that gesture. |
| Hold **C** and drag with images selected | Crops the selected images to the dragged screen rectangle. | Replaces normal canvas drag while C is held. |
| Double-click a custom-cropped image | Removes the plugin's custom viewport crop. A second double-click opens Excalidraw's native crop editor. | Adds an intermediate uncrop step for custom crops. |
| Right-button drag in an editable PureRef Popout | Moves the Popout OS window. | Replaces the normal right-click drag only in the Popout. |

All image crop and flip operations are one undoable Board change. A gesture with
no selected image is left alone, except that plain Alt-drag is still normalized
to a normal move so it cannot duplicate a newly clicked element.

## Keyboard shortcuts

| Shortcut | Plugin behavior | Scope |
| --- | --- | --- |
| **Ctrl+−** / **Ctrl++** with selected elements | Changes selected element opacity by 10%. | Normal view and editable Popout. |
| **Ctrl+−** / **Ctrl++** without a selection | Does nothing in a normal Excalidraw view. Changes the editable PureRef Popout's whole-window opacity by 5%. | As stated. The Popout consumes this shortcut so Excalidraw does not zoom. |
| **Ctrl+Arrow** | Packs selected packable references toward that edge. | Normal view and editable Popout. |
| **Ctrl+Shift+P** | Rearranges selected packable references into a compact layout. | Normal view and editable Popout. |
| **G** / **R** / **S** with selected elements | Starts a Blender-style move, rotation, or uniform scale around the selection center. Move to preview; left-click or Enter commits; Esc or right-click cancels. Hold **Shift** during rotation to snap to 15° increments. | Normal view and editable Popout. |
| **R** without a selection | Does not select the Rectangle tool. Excalidraw's **2** shortcut remains available. | Normal view and editable Popout. |
| **Alt+R** with selected elements | Resets rotation to 0, each element turning about its own center. | Normal view and editable Popout. |
| **Alt+S** with selected images | Resets each image to 100% scale — its native pixel size, the same size the plugin imports at — about its own center. A natively cropped image resets to its visible crop, never re-exposing cropped-away content. Rotation and flips are preserved. | Normal view and editable Popout. |
| **Alt+S** otherwise | Does nothing. Excalidraw's "toggle object snap" shortcut is dropped because it also force-disables grid mode; toggle object snap from the canvas context menu instead. | Normal view and editable Popout. |
| **Alt+R** while an Excalidraw drawing is the active leaf | Never runs Templater's "Replace templates in the active file" (which errors on a drawing). Templater's Alt+R still works in every markdown context. | Excalidraw drawing (non-markdown) mode only. See [Obsidian hotkey interception](integrations/obsidian-hotkey-interception.md). |
| **F11** | Opens or closes the PureRef Popout for the active Board. | An Excalidraw Board. |
| **F10** | Switches an existing editable Popout and its read-only transparent reference mode. | Only when one of those modes exists. |

## Popout defaults

Editable PureRef Popouts are always-on-top and hide Obsidian chrome. They also
enable Excalidraw's **overlap** box-selection mode, so a marquee selects every
element it touches rather than only elements fully enclosed by it. The plugin
preserves a Popout's viewport and native window opacity across editable/read-only
mode switches.

## Import and media behavior

- The plugin sanitizes dropped attachment filenames that cannot safely appear in
  Obsidian wikilinks, then passes the drop through Excalidraw's normal importer.
- If Excalidraw's “Insert File From Vault” dialog presents exactly one choice,
  the plugin selects it automatically.
- Inserted local videos and animated images are resized to their intrinsic aspect
  ratio after Excalidraw has added them.
- Inserted images are resized to their **native pixel dimensions** (PureRef-style),
  so relative resolutions line up 1:1 and a higher-resolution image imports larger
  than a lower-resolution one, instead of every image being clamped to the same
  size. Applies to freshly inserted images only; images already on the Board are
  left as-is.

These integrations are designed to be additive where possible. The explicit
gesture and shortcut overrides above are the intentional exceptions.
