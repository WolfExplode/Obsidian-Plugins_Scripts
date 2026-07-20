# Popout leaf is fully editable, not a read-only mirror

The Popout is a second, independent `WorkspaceLeaf` (via `app.workspace.openPopoutLeaf()`) opened on the same `.excalidraw` file as the originating leaf, not a duplicate/move of that leaf. Excalidraw exposes a first-class read-only `viewModeEnabled` mode that looked like the "safe" choice for a secondary leaf on a shared file, but we rejected it: PureRef's entire value is direct manipulation (drag/zoom/rotate/resize images) inside the floating window itself, and a read-only Popout would defeat that.

We're relying on Obsidian's ordinary vault-file-reload behavior across leaves — the same mechanism already used by other plugins (e.g. `synaptic-hatch` popping out markdown notes) — to keep both leaves in sync. The theoretical risk is concurrent edits from both leaves at once, but since a human only drives one window at a time, real simultaneous edits can't happen in practice.
