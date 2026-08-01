# Obsidian wikilink-unsafe attachment names

## Scope

This is a workaround for an Obsidian vault-attachment limitation, not an
Excalidraw interaction override. It applies to any file dropped for import
(main window or Popout) whose name contains one of `# ^ [ ] |`.

Implementation lives in [popout-drop-bridge.ts](../../src/popout-drop-bridge.ts)
(`sanitizeAttachmentName` / `desanitizeAttachmentName`), reused by
[media-auto-pack.ts](../../src/media-auto-pack.ts) for import-tracking name
matching.

## Symptom

Drop a file whose name contains `#`, `^`, `[`, `]`, or `|` (e.g.
`#温柔甜美.mp4`) and it imports as a broken, unresolvable tile.

## Root cause

These are Obsidian wikilink metacharacters. A vault attachment named with one
can't be referenced by a working `![[…]]` embed — the link never resolves.
Excalidraw records the dropped file's path into the scene as a raw string, not
an Obsidian link object, so no later rename can heal the reference; the name
has to be made legal *before* Excalidraw writes the file.

This is an Obsidian naming rule, not an Excalidraw limitation — the same file
dropped into a plain Obsidian note has the identical broken-wikilink problem.

## Fix

Each offending ASCII character is mapped to its full-width Unicode look-alike
before Excalidraw's importer sees the name. The mapping is link-legal, visually
near-identical, and reversible:

| ASCII | Replacement |
| --- | --- |
| `#` | `＃` FULLWIDTH NUMBER SIGN |
| `^` | `＾` FULLWIDTH CIRCUMFLEX ACCENT |
| `[` | `［` FULLWIDTH LEFT SQUARE BRACKET |
| `]` | `］` FULLWIDTH RIGHT SQUARE BRACKET |
| `\|` | `｜` FULLWIDTH VERTICAL LINE |

`desanitizeAttachmentName` folds the wide forms back to ASCII so code that only
ever sees the original dropped filename (media-auto-pack's import tracking)
still recognizes a vault file this renamed.

## Note on the Popout cross-realm bridge

`popout-drop-bridge.ts`'s main job is unrelated: healing cross-realm
`File`/`ArrayBuffer` drops into a Popout (see the file's module-level comment).
Filename sanitization piggybacks on that same clone-and-re-dispatch path
because both need to intercept the drop before Excalidraw's importer runs, but
sanitization itself is not Popout-specific — it fires in the main window too
whenever a dropped name is wikilink-unsafe.
