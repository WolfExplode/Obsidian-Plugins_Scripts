# Obsidian–Excalidraw generated-image lifecycle

## Scope

This guide defines the runtime contract for creating, replacing, or deleting an
image file that an open Obsidian Excalidraw Board will render. It applies to the
rotated-image crop implementation, but is intentionally broader: any feature
that materializes an image into the vault and changes an Excalidraw element's
`fileId` must follow it.

The host-independent transaction lives in
[generated-image-transaction.ts](../../src/generated-image-transaction.ts), and
the Obsidian/Excalidraw adapter lives in
[obsidian-excalidraw-generated-images.ts](../../src/obsidian-excalidraw-generated-images.ts).
[crop-orchestrator.ts](../../src/crop-orchestrator.ts) plans crop geometry and
hands the resulting patches and files to that boundary. The rotated-crop
product decision is in [ADR 0009](../adr/0009-image-crop-drag.md).

## Why this exists

Generated images cross several stores that look interchangeable but are not.
An image may exist on disk and open through Obsidian's link menu while the
Excalidraw canvas and export still display a missing-image texture. Conversely,
an image can render immediately and disappear after background save or reload.

Do not collapse or reorder the registration steps without testing immediate
rendering, background save, and plugin reload.

| Layer | Owns | Required operation |
| --- | --- | --- |
| Obsidian vault | PNG bytes and the `TFile` | `vault.createBinary()` at a normal, indexed path |
| `ExcalidrawData.files` | Open-view mapping from element `fileId` to `EmbeddedFile` | Construct the generated-path record, call `setImage()`, then `setFile()` |
| Excalidraw plugin `filesMaster` | Durable mapping used to rebuild `EmbeddedFile`s | Written by `ExcalidrawData.setFile()` |
| Excalidraw core binary store/cache | Pixels for the immediate canvas renderer/exporter | `excalidrawAPI.addFiles()` |
| Persisted scene | The element-to-file relationship and binary map | One `view.updateScene({ elements, files, ... })` call |

## Required creation order

1. Generate the new `fileId`, then choose a normal vault path beside the source
   image that includes that ID. This gives concurrent operations distinct,
   transaction-owned cleanup targets.
2. Create the PNG with `vault.createBinary()`.
3. Construct an `EmbeddedFile` for the generated path, populate it with
   `setImage({ imgBase64, mimeType, size, ... })`, and register it through
   `ExcalidrawData.setFile()`.
4. Call `excalidrawAPI.addFiles()` for the new binary. This inserts the new ID
   into Excalidraw core and primes the immediate renderer.
5. Submit the changed elements and the complete binary map together through
   `view.updateScene({ elements, files, ... })`.
6. Read the live elements back and verify the transaction's version nonces.
   `updateScene()` catches some internal failures, so a non-throwing call is not
   proof that the Board accepted the change.

Steps 4 and 5 serve different systems and both are required. `addFiles()` alone
is not durable; `updateScene({ files })` alone does not reliably add an unknown
binary to the immediate core store.

## Required cleanup order

1. Recover the remembered source binary and add it back to Excalidraw core.
   After reopening a Board, this may require reading the remembered source path
   from the vault because only the generated crop is resident in core.
2. Update the element back to its remembered source `fileId` (or to the
   replacement generated `fileId`), submitting the complete binary map in the
   same scene update.
3. Wait until the live scene no longer references the old generated ID.
4. Remove the generated `EmbeddedFile` registration.
5. Delete the generated vault attachment.

Deleting the file in the same call stack as the element switch can race
Excalidraw's renderer and produce a false "could not find image file" warning.
The restored source is an existing prerequisite, not a transaction-created
asset, so a later commit failure must not delete it during rollback.

## Non-obvious constraints

- **Never use a dot-prefixed generated filename.** Obsidian excludes dotfiles
  from its vault index. The bytes can exist on disk while the Files view and
  `vault.getAbstractFileByPath()` report no file.
- **Use only word characters in generated `fileId`s.** Obsidian Excalidraw
  parses Embedded Files IDs with a pattern equivalent to `[\w\d]*`.
  Hyphenated IDs can work in the current scene and then silently fail to
  round-trip through background save/reload.
- **A `TFile` is not a loaded `EmbeddedFile`.** A new record defaults to
  `application/octet-stream`, `0×0`, and an empty image. Populate it with
  `setImage()` before calling `setFile()`.
- **Persist the element and files atomically.** Never issue an element-only
  scene update and provide the corresponding files in a later update. Obsidian
  can save the intermediate, broken state between calls.
- **Patch a fresh element array.** Rasterization and vault writes are async. A
  full array captured before them can revert unrelated edits. Re-read immediately
  before commit and reject when any target's revision changed.
- **Rollback is durable and awaited.** Before a verified commit, remove the
  generated `EmbeddedFile` registration and await vault deletion. If the commit
  postcondition cannot be read, retain both generations: deleting either one can
  corrupt a Board whose actual commit state is unknown.
- **Core rollback is intentionally incomplete.** `addFiles()` is additive and
  exposes no removal API. A failed post-registration commit may leave an
  unreferenced binary in Excalidraw's in-memory core store until the view closes;
  durable registries and vault files are still rolled back.

## Diagnostic guide

| Symptom | Likely missing contract |
| --- | --- |
| Open link succeeds, but canvas/export shows a missing-image icon | Core binary/cache was not registered with `addFiles()` |
| Image appears only after reload | Immediate core registration was skipped |
| Image works initially, then breaks after save/reload | Invalid `fileId` grammar or files were not included in the persisted scene update |
| File exists on disk but is absent from Obsidian's file index | Dot-prefixed path |
| Embedded record reports `application/octet-stream` and `0×0` | `EmbeddedFile.setImage()` was skipped |

## Verification checklist

For any change to this flow, verify all of the following against a live Board:

- The generated image renders immediately after the operation.
- Right-click **Open link** opens the generated vault file.
- The image still renders after Obsidian's background save settles.
- The image still renders after plugin reload (and, when relevant, Board reload).
- Cancelling/replacing a crop restores the source before deleting the generated
  file, with no missing-file warning.
