# Excalidraw PureRef

Excalidraw PureRef is a desktop-only Obsidian plugin for using an
[Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) Board as
a PureRef-style reference surface. Visit the [original app's website](https://www.pureref.com/) to find out the eventual intended feature set of this plugin. 

Turns an Excalidraw Board into a always-on-top reference Popout. 
See the complete [interaction reference](docs/behavior/user-interaction-overrides.md).

## Features

### **Popout window** 
- Pop the active Board out into a chrome-free,
  always-on-top OS window (**F11**) that can be dragged with a right-button
  drag, and toggled between a fully editable mode and a separate transparent,
  click-through reference mode (**F10**).

- **Opacity control** **Ctrl+−/+** adjusts selected-element opacity, or the
  whole Popout window's opacity when nothing is selected.
  
https://github.com/user-attachments/assets/b30dba76-fb94-49ec-b3e8-ca915fdcafd4

### **Image crop, flip, and transform**
  - Hold **C** and drag to crop selected images to a rectangle.
  - **Alt+Shift-drag** to flip selected images horizontally or vertically.
  - **Alt+double-click** to remove a crop. Double-click a custom-cropped image
    to open Excalidraw's native crop editor.
  - Blender-style **G** / **R** / **S** move, rotate, and scale. 
  - **Alt+R** / **Alt+S** to reset rotation or scale back to native size.

https://github.com/user-attachments/assets/fda37d9a-c42b-4f69-adbe-68710d3f4a9d

### **Arrangement and packing**
  - **Ctrl+Arrow** packs selected references toward an edge. **Ctrl+Shift+P**
    arranges the selection into a compact layout.
  - **Ctrl+Alt+Arrow** normalizes selected images to matching height, width,
    size, or scale (also in the context menu under **Normalize**).
  - Multi-file media drops are auto-arranged into a compact PureRef-style
    block.
  - Overlap-aware **Bring Forward** / **Send Backward** (**Ctrl+]** /
    **Ctrl+[**) jumps past non-overlapping elements instead of one slot at a
    time.

https://github.com/user-attachments/assets/6c0136df-f822-4b36-8e56-7852c0023c16

### **Media import/export**
  - Drag-and-drop import for images, animated images (`.gif`/`.webp`/`.apng`
    become playing embeddables), and video, with automatic filename
    sanitization and aspect-ratio correction.
  - **Ctrl+Shift+E** exports every selected image/video/embed to a folder,
    rendering cropped images to a fresh PNG of just the visible crop.

https://github.com/user-attachments/assets/ef692124-d11f-45e1-9bf0-eae5ea1d6914

### **Find Duplicates** Right-click (or **Ctrl/Cmd+F**) with one element
  selected to find and select every other element on the Board that matches
  it by file, link, or geometry.

https://github.com/user-attachments/assets/f46d778a-d19e-4333-923e-546536047d4a

### **Draw on Embeddables**

- In default Excalidraw, nothing can ever be drawn or placed in front of a video/PDF/markdown/web embed. This plugin fixes that.

https://github.com/user-attachments/assets/6fabca8b-9dae-4148-8c86-74e51e6ee2b9

## Requirements

- Obsidian Desktop v1.13.4 or newer (I have not tested older versions of obsidian)
- The [Obsidian Excalidraw community plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin).
- I have not tested mac or linux systems so consider this plugin windows only. 

## Install for development
This plugin is still in development so it is not yet available on [community plugins](https://community.obsidian.md/plugins), pending review.

1. Clone this repository into your vault's `.obsidian/plugins/excalidraw-pureref/`
   folder.
2. Run `npm install` in the repository root.
3. Run `npm run build` after every source change.
4. In Obsidian, enable both **Excalidraw** and **Excalidraw PureRef** in
   Community plugins.

## Documentation

The [documentation guide](docs/README.md) routes both users and contributors to the right material.

For contributor workflow and repository-specific guardrails, see [AGENTS.md](AGENTS.md).

### Current status
As the plugin is now, it's fully functional as a reference board, but still lacks some of the features that make pureref, pureref. (The transparent read-only Popout mode was the only way I managed to get some of the transparency features to render properly, if it feels clunky to use... I know.)

`.pur` file import/export is not supported. PureRef's file format changed between its 1.x and 2.x releases, and the 2.x format was not able to be reverse engineered, so interchange is limited to the Board's native `.excalidraw` file.

### Limitations

I've decided to delegate file format support to a different plugin. See This [plugin fork](https://github.com/WolfExplode/obsidian-extended-file-support/tree/Main-development-branch) for more information

## Contributing

Feel free to open any issues or fork this repo and implement your own changes.
