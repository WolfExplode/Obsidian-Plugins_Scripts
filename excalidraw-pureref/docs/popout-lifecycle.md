# Popout lifecycle

`PopoutManager` is the lifecycle module for editable Popouts and transparent reference mode. Callers use its command-oriented interface; ordering, cancellation, native-window correlation, and cleanup remain inside the module.

## States

Each tracked Board Popout has one state:

- `opening`: Obsidian created the leaf, but the Excalidraw canvas has not completed initialization.
- `ready`: window controls, Excalidraw canvas, startup camera, and interaction hooks are usable.
- `closing`: ownership has been invalidated and cleanup has started.

Transparent reference mode does not create a second lifecycle for the Board. It temporarily hides the ready editable Popout and presents the separate transparent window accepted by ADR 0008.

## Invariants

1. User-triggered F10/F11 transitions execute in request order. An open transition does not finish until the Board reaches `ready`, so a queued close cannot detach Excalidraw during mount.
2. Every asynchronous continuation verifies that it still owns the same Board entry. A file path alone is not lifecycle identity.
3. A native `window-close` event may clean up an entry only when its `Document` is the tracked Popout document. A delayed event from an older Popout cannot remove a newer one for the same Board.
4. Programmatic and native closes share idempotent cleanup. Bounds and viewport are captured before the native window or Excalidraw interface becomes unavailable.
5. Plugin-data writes and ExcalidrawAutomate renders are serialized because each uses mutable shared state.
6. Plugin unload invalidates current work immediately, then waits for the active transition to settle before detaching leaves.

## Window correlation

The Electron adapter first resolves a BrowserWindow from the Popout DOM window's own renderer realm. The id-difference heuristic remains only as a fallback, and a correlated id is accepted only when it did not exist before `openPopoutLeaf()`.

## Initialization failure

Missing Excalidraw registration, missing Popout documents, failed native-window discovery, and canvas-readiness timeout all terminate the incomplete open and restore the global Excalidraw resize setting. No failure path may leave a placeholder Board marked open.
