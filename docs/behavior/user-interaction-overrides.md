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
| **Alt+double-click** with cropped images selected | Removes the plugin's custom viewport crop when present; otherwise removes Excalidraw's native crop, restoring each image in place. | Adds a consistent uncrop gesture for both crop layers. |
| Double-click a custom-cropped image | Opens Excalidraw's native crop editor for the generated image. | No longer removes the plugin's custom viewport crop. |
| Right-button drag in an editable PureRef Popout | Moves the Popout OS window. | Replaces the normal right-click drag only in the Popout. |
| **Ctrl/Cmd+wheel** or pinch zoom in an editable PureRef Popout | Changes zoom by Excalidraw's base linear wheel delta, anchored at the cursor. | Removes Excalidraw's additional logarithmic acceleration above 100% zoom. Normal Excalidraw views retain native zoom behavior. |

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
| **G** / **R** / **S** with selected elements | Starts a Blender-style move, rotation, or uniform scale around the selection center. Move to preview; left-click or Enter commits; Esc or right-click cancels. Hold **Shift** during rotation to snap to 15° increments. | Normal view and editable Popout. See [Excalidraw shortcut interception](../integrations/excalidraw-shortcut-interception.md) for how this shadows Excalidraw's own G/R/S bindings, version-pinned to Excalidraw core 0.18.0. |
| **R** without a selection | Does not select the Rectangle tool. Excalidraw's **2** shortcut remains available. | Normal view and editable Popout. |
| **Alt+R** with selected elements | Resets rotation to 0, each element turning about its own center. | Normal view and editable Popout. |
| **Alt+S** with selected images | Resets each image to 100% scale — its native pixel size — about its own center. A natively cropped image resets to its visible crop, never re-exposing cropped-away content. Rotation and flips are preserved. | Normal view and editable Popout. |
| **Alt+S** otherwise | Does nothing. Excalidraw's "toggle object snap" shortcut is dropped because it also force-disables grid mode; toggle object snap from the canvas context menu instead. | Normal view and editable Popout. |
| **X** | Deletes the selected elements. | Replaces Excalidraw's **X** shortcut for the free-draw tool. Normal Excalidraw deletion rules, including frames, bindings, and groups, still apply. |
| **Ctrl+Alt+Left** / **Right** with two or more images selected | Resizes the selected images, centered in place, to their average displayed height / width. | Normal view and editable Popout. Also available from the canvas context menu: **Normalize → Height / Width**. |
| **Ctrl+Alt+Up** / **Down** with two or more images selected | Resizes the selected images, centered in place, to their average displayed area / average native-image scale. | Normal view and editable Popout. Also available from the canvas context menu: **Normalize → Size / Scale**. |
| **Alt+R** while an Excalidraw drawing is the active leaf | Never runs Templater's "Replace templates in the active file" (which errors on a drawing). Templater's Alt+R still works in every markdown context. | Excalidraw drawing (non-markdown) mode only. See [Obsidian hotkey interception](../integrations/obsidian-hotkey-interception.md). |
| **F11** | Opens or closes the PureRef Popout for the active Board. | An Excalidraw Board. |
| **F10** | Switches an existing editable Popout and its read-only transparent reference mode. | Only when one of those modes exists. |
| **Ctrl+Shift+E** | Exports every selected image/video/embed to a folder chosen via the native OS dialog. A natively cropped image is rendered to a fresh PNG holding only its visible crop (flips included); an uncropped image or any other local media file is copied byte-for-byte. | Normal view and editable Popout, when a Board is the active leaf. |

## Popout defaults

Editable PureRef Popouts are always-on-top and hide Obsidian chrome. They also
enable Excalidraw's **overlap** box-selection mode, so a marquee selects every
element it touches rather than only elements fully enclosed by it. The plugin
preserves a Popout's viewport and native window opacity across editable/read-only
mode switches. While at least one editable Popout is open, the plugin temporarily
turns off Excalidraw's global **zoom to fit on view resize** setting. This keeps
the canvas from refitting while the Popout is moved or resized, and restores the
user's prior setting after the last Popout closes; because Excalidraw owns this
setting globally, the normal Board view is affected for that interval too.

## Import and media behavior

- The plugin sanitizes dropped attachment filenames that cannot safely appear in
  Obsidian wikilinks, then passes the drop through Excalidraw's normal importer.
- If Excalidraw's “Insert File From Vault” dialog presents exactly one choice,
  the plugin selects it automatically.
- Inserted local videos and animated images are resized to their intrinsic aspect
  ratio after Excalidraw has added them.
- Newly inserted `.gif`, `.webp`, and `.apng` files are converted from static
  image elements into playing Excalidraw embeddables. Animated images already
  present in a saved Board are not changed.
- Animated-image embeddables now stretch to fill their element box when
  resized, matching video/pdf/markdown embeddables. This works around an
  upstream Obsidian Canvas limitation; see
  [Obsidian Canvas image-embed stretch fix](../integrations/obsidian-canvas-image-stretch-fix.md).
- A multi-file media import is automatically arranged as a compact PureRef-style
  block. Only media created by that import moves; existing Board content stays
  in place. Packing occurs after Obsidian Excalidraw's native
  `synchronizeWithData()` import-sync promise resolves, rather than on a delay
  or on the earlier vault-save event; this prevents the importer from restoring
  its pre-pack scene snapshot over videos and other embeddables.

These integrations are designed to be additive where possible. The explicit
gesture and shortcut overrides above are the intentional exceptions.
