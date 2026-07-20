# Excalidraw-PureRef

An Obsidian plugin that recreates PureRef's reference-board workflow (floating, always-on-top image boards for visual reference) by orchestrating existing Obsidian and Excalidraw building blocks rather than forking either.

## Language

**Host plugin**:
The Obsidian plugin we are building. It is a standalone Obsidian plugin — not a fork or extension of the Excalidraw community plugin's own codebase.
_Avoid_: "the Excalidraw plugin" (that refers to the third-party dependency, not our code)

**Board**:
A single Excalidraw canvas (`.excalidraw` file) used as a PureRef-style reference board — the surface holding freely transformed, overlapping images.
_Avoid_: Scene (PureRef's term, kept out of our glossary to avoid confusion with Excalidraw's own "scene" data structure), Canvas (ambiguous with Obsidian's native Canvas core feature, which this project does not use)

**Excalidraw canvas**:
The third-party Excalidraw community plugin's rendering surface and element model (images, groups, frames), which the host plugin drives and manipulates but does not own or fork.
_Avoid_: Excalidraw plugin (when referring to the surface itself rather than the dependency)

**Popout**:
A chrome-free, always-on-top OS window hosting exactly one Board, spawned from a normal Excalidraw view via F11. The originating Excalidraw view stays open and usable in the main window; the Popout is a synced second view onto the same Board, not a replacement for the first. Multiple Popouts may be open at once (one per Board), each independently positioned. F11 is a true toggle: pressed in the originating Excalidraw view it opens/closes that Board's Popout; pressed inside the Popout itself it always closes it.
_Avoid_: Window (too generic — use Popout whenever referring to this specific chrome-free always-on-top window), tab (there is no tab-switching model here), "PureRef mode" (an earlier, rejected idea where the main window itself was converted in place rather than spawning a second window)

A Popout hides both layers of chrome: Obsidian's outer chrome (ribbon, tabs, sidebars, status bar) and Excalidraw's own in-canvas UI (toolbar, style panel, zoom controls, library panel) — nothing but the bare drawn canvas is visible. All interaction is hotkey/mouse-driven (paste, drag-drop, scroll-zoom, click-drag pan, right-click context menu); no on-canvas UI is ever shown for this feature's own configuration.

Chrome hiding is enforced via inline `!important` styles set from JS (`chrome-hider.ts`), not a plain CSS class — real-world testing showed other installed plugins/snippets can define same-specificity `!important` rules (e.g. Style Settings-style `show-ribbon`/`show-view-header` toggle classes) that win the cascade tie on source order, silently defeating a class-based approach.

Holding the right mouse button and dragging moves the Popout window itself (matching real PureRef), instead of opening Excalidraw's context menu. This is exclusive to Popouts — a plain right-click with no drag still opens Excalidraw's context menu as normal, and the behavior is never active in the main (non-Popout) Excalidraw view.

While any Popout is open, the host plugin temporarily forces the Excalidraw plugin's **"Zoom to fit on view resize"** setting off, restoring the user's original value once the last Popout closes (`excalidraw-settings.ts`). This is because moving the Popout via RMB-drag calls Electron's `setBounds`, which carries a size component and so emits a stream of `resize` events on Windows; with "zoom to fit on view resize" on, Excalidraw refits the board to its content on each one, making the canvas visibly snap/rescale while you drag the window. That Excalidraw setting is a single **global** toggle, not per-view, so suppressing it also affects the originating main-window view for as long as a Popout is open — an accepted trade-off. Users who never open Popouts, or who want to be sure, can also just disable "Zoom to fit on view resize" in Excalidraw's own settings.

The host plugin tracks each Board's Popout open/closed state and last window geometry regardless of how the Popout was closed (F11 or the native OS close control) — every close path updates the same tracked state and persists the same geometry, so F11 in the originating view always knows correctly whether to open a fresh Popout or focus/close an existing one.

Alongside window geometry, the host plugin persists each Board's Popout **canvas camera** (Excalidraw scroll + zoom). The rule is *mirror on first launch, then persist*: a Board that has never been popped out opens its Popout framed on whatever the main view is currently showing (the same scene point re-centered for the Popout's own window size); after that, the Popout's framing is saved on every close and restored on reopen, so it behaves as a persistent independent reference view rather than re-snapping to the main view each time. The camera is stored in Excalidraw scene units (not pixels), and because window bounds are restored before the camera is applied, a restore reproduces the exact framing. This mirrors the window-geometry contract — same store (`geometry-store.ts`, in `data.json`), same "every close path persists" discipline. The camera is read/written only through the Excalidraw view's live imperative API (`excalidrawAPI`), never by importing the Excalidraw plugin (ADR 0001).
_Avoid_: mirror-on-every-open (rejected — it discards a Popout's deliberately-arranged reference framing), top-left alignment (the mirror matches the viewport **center**, since the two windows differ in size)

**Plugin settings tab**:
The host plugin's entry in Obsidian's own Settings panel — the sole configuration surface for this feature's appearance and behavior. There is deliberately no in-canvas settings UI; anything configurable is set here, not on the Board itself.
_Avoid_: Options panel, preferences (when referring to something other than this specific settings tab)

**PureRef interchange**:
Two-way conversion between a Board's native `.excalidraw` file and PureRef's `.pur` format (both import and export), built on the reverse-engineered `purformat` reference code. `.excalidraw` remains the source of truth for editing; `.pur` is always a converted artifact at the moment of import or export, never edited directly by the host plugin.
_Avoid_: Save format, native format (when meaning `.pur` — `.excalidraw` is the native format), one-way (both directions are supported)

Triggered only via command palette actions ("Import `.pur` file...", "Export Board as `.pur`...") against the OS filesystem through file pickers/save dialogs — `.pur` files are never placed in or read from the vault directly, and are not integrated into Obsidian's file explorer.
