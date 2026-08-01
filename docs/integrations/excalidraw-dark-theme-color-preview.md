# Excalidraw dark-theme colour preview mismatch

## Scope

This is upstream Excalidraw behavior, not a host-plugin defect. A light authored
colour can appear muted in the colour swatch and on a dark Board while retaining
its original hex value.

## Contract

Excalidraw stores one authored colour and transforms it for dark-theme display:

- the colour-picker swatch uses Excalidraw's `--theme-filter` CSS;
- canvas rendering applies `applyDarkModeFilter(color, isDarkMode)`;
- colour emoji may remain vivid because their font glyphs contain their own
  colour layers and do not obey `fillStyle` like ordinary text.

The relevant upstream implementations are
[`DARK_THEME_FILTER`](../../reference/excalidraw-master/packages/common/src/constants.ts),
[`applyDarkModeFilter`](../../reference/excalidraw-master/packages/common/src/colors.ts),
and the calls in
[`renderElement.ts`](../../reference/excalidraw-master/packages/element/src/renderElement.ts)
and [`shape.ts`](../../reference/excalidraw-master/packages/element/src/shape.ts).

## Host-plugin behavior

Front-of-embed rendering reads the authored element colour and applies the same
dark-theme filter to its drawn pass. Its image-blit path already contains the
filtered canvas pixels. It therefore mirrors Excalidraw rather than introducing
another colour transform.

Report changes to this behavior upstream in `excalidraw/excalidraw`, or in
`zsviczian/obsidian-excalidraw-plugin` if the bundled version pin is involved.
