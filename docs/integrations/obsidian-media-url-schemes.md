# Loading local media by URL: which scheme works in which window

## Scope

Any code that builds a URL for a vault file and hands it to a `<video>`, `<img>`,
or `<audio>` element. This plugin does that in two places, and they deliberately
use **different URL schemes for the same vault file**. Read this before
"unifying" them.

## The contract

| Window | `file://` | `app.vault.getResourcePath(file)` |
| --- | --- | --- |
| Main window and Obsidian Popouts | **Blocked** — `webSecurity` rejects it | Works |
| The F10 transparent read-only window | Works | n/a (that window has no `app`) |

A blocked `file://` load is quiet: the element fires `onerror`, reports no
dimensions, and renders nothing. There is no console message identifying the
scheme as the cause, which is what makes this worth documenting.

## Why each path uses what it does

**Main window / Popouts — `getResourcePath`.** The media aspect-ratio corrector
probes a file's true `videoWidth`/`videoHeight` with an off-screen element before
refitting the embeddable's box, and it runs inside normal Obsidian renderers.
[video-aspect.ts](../../src/video-aspect.ts) therefore resolves the link to a
`TFile` and calls `plugin.app.vault.getResourcePath(dest)`, which returns an
`app://<hash>/…` URL the renderer is permitted to load.

**F10 transparent window — `file://`.** The read-only window is our own
`BrowserWindow` created in the main process, not an Obsidian window, and it is
constructed with `webSecurity: false` plus
`autoplayPolicy: "no-user-gesture-required"` in
[transparent-proto.cjs](../../transparent-proto.cjs) precisely so it can load and
autoplay local media. [board-render.ts](../../src/board-render.ts)'s
`collectMediaOverlays()` builds `pathToFileURL(join(basePath, dest.path)).href`
for the mp4/gif overlays it paints over the exported SVG. `getResourcePath` is
not available there — that window has no Obsidian `app` — so `file://` is not
merely a preference, it is the only option.

## Consequences

- Moving media-loading code between the two contexts requires changing the
  scheme, not just the call site.
- A helper shared by both paths must take a resolved URL as a parameter rather
  than building one internally.
- If overlays in the F10 window stop rendering, check whether `webSecurity` is
  still disabled on that window before suspecting the overlay geometry.

## Related

- [Popout lifecycle](../popout-lifecycle.md) — which windows exist and who owns them
- [ADR 0008](../adr/0008-editable-and-transparent-modes-use-separate-windows.md) —
  why the transparent window is a separate window in the first place
