# Excalidraw canvas mutations

## Scope

An Excalidraw canvas mutation is a durable, host-plugin-owned change to existing
element fields through `updateScene`. The shared implementation lives in
`src/excalidraw-element-mutation.ts`; feature planning remains with opacity,
packing, normalization, crop, and other behavior modules.

Per ADR 0001, use an upstream Excalidraw gesture when it already owns the
operation's semantics. G/R/S therefore remain native pointer transforms. The
mutation module exists for operations that have no equivalent gesture; it is
not a replacement drawing engine or a generic wrapper around every scene write.

## What the mutation module owns

`commitElementMutation` owns the mechanics every durable field patch needs:

- re-read the current element array immediately before committing;
- optionally reject an async plan whose target revision changed;
- preserve the object identity of every untouched element;
- apply patches and stamp `version`, `versionNonce`, and `updated` once;
- emit one durable `IMMEDIATELY`/history write through the live adapter;
- distinguish applied, no-op, conflict, unavailable, and failed outcomes.

The Excalidraw view adapter logs genuine write failures centrally. A revision
conflict is an expected cancellation: the user's newer edit wins.

## Operation audit

| Write kind | Examples | Shared durable mutation? | Reason |
| --- | --- | --- | --- |
| Field-local durable patch | opacity, flip | Yes | No native gesture is available to the calling interaction; revision/history mechanics are identical. |
| Planned geometry patch | Normalize, Reset Scale, Alt+R, video aspect correction | Yes | The shared commit prevents stale async geometry from overwriting a newer edit. It does not add native relationship semantics. |
| Packing translation | gravity pack, optimal import pack | Yes, for the commit only | Pure planners retain the layout rules; the mutation module applies their translations to the latest positions. |
| Array reorder | overlap-aware forward/backward | No | Array position is the behavior's source of truth, not an element-field patch. Group/frame cases already fall through to Excalidraw. |
| Native pointer transform | G/R/S | No | Excalidraw must own bindings, bound text, frames, snapping, and history. |
| Transient infrastructure | transform proxy, cancel snapshot restore | No | These deliberately use `EVENTUALLY`, selection app state, or full-Board restoration. |
| App-state/view write | viewport, zen mode, overlap selection, duplicate selection | No | No element revision or durable element history is involved. |
| Generated-image transaction | rotated crop and uncrop | No | Vault files, ExcalidrawData, core files, and the element/file map have a strict lifecycle and atomic final write. |

The unused direct-deletion helper was removed during this audit. Native deletion
owns binding and frame cleanup, so reviving a generic `isDeleted` patch would be
incorrect.

## Async planning rule

Any calculation that crosses an `await` must capture the target elements'
`version` and `versionNonce` before starting and pass those expected revisions
to the durable mutation. Reset Scale and Normalize Scale decode image data and
follow this rule. Rotated crop retains its stricter specialized guard because it
also changes `fileId`, custom crop data, registered binaries, and vault files.

## Known semantic limit of direct geometry writes

Centralized mutation mechanics do not make direct geometry writes equivalent to
native pointer transforms. Packing, normalization, rotation reset, crop, and
automatic media resizing can still bypass Excalidraw's private relationship
updates for externally bound arrows or frame membership. The public runtime
surface does not expose `updateBoundElements`, and forcing these operations
through the generic module must not pretend otherwise.

Keep feature-specific guards where they exist (packing treats groups as units;
z-order rejects groups/frames), prefer native gestures whenever one can express
the operation, and re-audit this limit when the bundled Excalidraw version
changes or exposes a relationship-aware mutation route.
