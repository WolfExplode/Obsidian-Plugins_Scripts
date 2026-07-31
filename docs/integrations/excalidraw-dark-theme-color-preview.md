# Excalidraw dark-theme colour preview mismatch

## Scope

Not a bug in this repo. Documented here only because it surfaced while
investigating [Front-of-embed rendering](../behavior/front-of-embed-rendering.md)
(a "Star" text element looked the wrong colour when drawn over an embeddable)
and turned out to be unrelated to that mechanism, or to this plugin, entirely.
Recorded so the next time it looks like a regression here, it's a five-minute
check instead of a re-investigation.

Verified live (2026-07-31) against **obsidian-excalidraw-plugin 2.25.3** in a
real vault, via a CDP connection (see [perf-profiling.md](../perf-profiling.md)
for how this repo normally uses that same remote-debugging connection).
Re-verify against the matching tag in `reference/excalidraw-master` if this
plugin's bundled Excalidraw version changes before trusting the specifics
below.

## What it looks like

A text element authored with a light, saturated colour (e.g. `#ffd983`) reads
back correctly in the hex field, but:

- its swatch preview in the stroke-colour popover renders as a dark,
  muted brown instead of the typed hex, and
- the same colour painted on the dark-theme canvas is similarly muted —
  *except* when the element is a colour emoji (`⭐`, `🌟`, ...), which stays
  vivid regardless of theme.

This reads as "the color picker and the canvas both show the wrong colour,"
and specifically as "this element looks different in front of an embeddable
than an identical one doesn't" if the muted element happens to sit over one —
which is what made it worth checking against
[front-of-embed-rendering.md](../behavior/front-of-embed-rendering.md) at all.

## Root cause (confirmed live, not front-of-embed)

**The swatch preview.** Selected the text element, forced its stroke popover
open via `updateScene({ appState: { openPopup: "elementStroke" } })`, then read
the DOM directly:

- The button's `--swatch-color` CSS variable is the correct, untouched hex
  (`#ffd983` — confirmed via `getComputedStyle(...).backgroundColor` reading
  back `rgb(255, 217, 131)`, exactly that hex).
- The same button's `getComputedStyle(...).filter` is
  `invert(0.93) hue-rotate(180deg)`.
- That rule is `.excalidraw .color-picker__button { ... filter:
  var(--theme-filter); ... }`, found via `document.styleSheets` — scoped under
  Excalidraw's own `.excalidraw` root class, not an Obsidian or
  obsidian-excalidraw-plugin override. `--theme-filter` is Excalidraw's own
  variable, and `invert(93%) hue-rotate(180deg)` is their own
  `DARK_THEME_FILTER` constant
  ([constants.ts](../reference/excalidraw-master/packages/common/src/constants.ts)).

So the swatch preview is *deliberately* run through the same transform as
canvas colours in dark theme — Excalidraw is showing "how this will look on
the dark canvas," not the literal authored hex. Confusing, but intentional,
and entirely inside Excalidraw's own bundled CSS.

**The canvas.** Excalidraw does not store a light/dark pair per colour. It
stores one authored hex and recomputes a dark-theme display colour from it at
render time via `applyDarkModeFilter(color, isDarkMode)`
([colors.ts](../reference/excalidraw-master/packages/common/src/colors.ts)) —
same `invert(93%)` → `hue-rotate(180deg)` maths as the CSS rule above, just
run in JS instead of as a filter. This is called for:

- text and freedraw fill colour
  ([renderElement.ts:356,489](../reference/excalidraw-master/packages/element/src/renderElement.ts)),
- shape stroke/background going into RoughJS
  ([shape.ts:222,236,249,384](../reference/excalidraw-master/packages/element/src/shape.ts)).

For an ordinary glyph this substitutes `context.fillStyle` before `fillText`,
which works, because a plain glyph is rasterized using whatever `fillStyle`
says. A **colour emoji** glyph is not: browsers rasterize COLR/CPAL emoji
glyphs from the font's own embedded colour layers and ignore `fillStyle`
entirely, so the substitution has no visible effect. That's the whole
asymmetry — same code path, but one glyph type obeys the substituted colour
and the other doesn't.

## Why this isn't a front-of-embed issue

The front-of-embed overlay (`front-of-embed-view.ts`) does its own, separate
dark-theme handling — real `ctx.filter = DARK_THEME_FILTER` on the canvas
context for its drawn pass, not a `fillStyle` substitution — specifically so
its output matches what Excalidraw's own canvas would have shown. It reads
`element.strokeColor` (the same raw authored hex Excalidraw itself stores) and
applies the identical invert/hue-rotate transform Excalidraw uses. It isn't
introducing a second, competing transform; it's mirroring the one described
above. Whatever inconsistency the emoji case produces is inherent to
Excalidraw's fillStyle-substitution approach and shows up identically whether
or not the element happens to cross an embeddable.

## Where to report this, if anyone wants to

Upstream, against `excalidraw/excalidraw` (the swatch-preview-through-the-dark-filter
design, and/or the emoji fillStyle asymmetry) or `zsviczian/obsidian-excalidraw-plugin`
if a fix would need to land in the bundled version pin. Nothing to change here.
