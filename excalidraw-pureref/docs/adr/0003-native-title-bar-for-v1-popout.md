# Popout keeps the native OS title bar in v1; frameless is deferred

The Popout aims to be visually indistinguishable from real PureRef, which is fully frameless. Obsidian's `openPopoutLeaf()` window keeps a normal OS title bar by default; going frameless requires controlling the underlying Electron `BrowserWindow` at creation time (`frame: false`) and then reimplementing dragging/resizing/closing without the OS chrome that normally provides them.

For v1, we keep the native title bar and only strip in-page chrome (ribbon, tabs, sidebars, status bar) plus always-on-top. This gets most of the visual goal with far less risk. Frameless is deferred until the core interaction model (Popout lifecycle, always-on-top, chrome hiding, sync) is proven out, since it's a purely cosmetic last mile with real implementation cost.
