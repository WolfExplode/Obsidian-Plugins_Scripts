---
status: accepted
---

# The current Popout leaf is fully editable

The implemented Popout is a second, independent `WorkspaceLeaf` (via `app.workspace.openPopoutLeaf()`) opened on the same `.excalidraw` file as the originating leaf, not a duplicate or move of that leaf. This records the current editing surface; it does not rule out a future reference-only surface if switching to the editable Popout remains convenient.

The implementation relies on Obsidian's ordinary vault-file-reload behavior across leaves to keep both views synchronized. Concurrent edits are considered unlikely in normal use, but conflict-free synchronization has not been stress-tested.
