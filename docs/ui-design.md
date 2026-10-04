# UI design

The styling system for the web UI: monochrome design tokens, light and dark themes, and a validated colour palette reserved for data.

## Why
An interface that shows a whole pipeline at once gets noisy fast.
Keeping chrome monochrome and spending colour only on data means the one coloured number on screen is the one worth reading.
The palette is validated for colour-vision deficiency so that meaning survives for every reader.

## How it works
All tokens live in `web/src/global.css`.
`:root` defines the dark theme as the default, and `[data-theme="light"]` overrides it.
Tokens are RGB triplets, so utilities can apply alpha (`rgb(var(--line) / var(--line-alpha))`).
An `@theme inline` block exposes them to Tailwind as colours (`foreground`, `background`, `muted`, `subtle`, `line`, `vector`, `keyword`, `slow`, ...), a five-step type scale with nothing under 11px, and three font families.
`web/src/app/ThemeToggle.tsx` sets `data-theme` on `<html>` and remembers the choice in `localStorage`, tolerating storage that throws.

### Colour policy
Monochrome carries the interface; colour carries only data.
The jobs colour is allowed, as listed in the `global.css` header:
- **Retriever identity:** blue for vector search, aqua for keyword search, ink (not a third hue) for both.
- **Latency as an exception:** amber at 1s or more, red at 5s or more, and fast stages deliberately uncoloured (`speedOf` in `web/src/lib/stages.ts`).
- **Delta direction** against a pinned baseline in the Results view: green up, red down, with the sign always printed.
- **The pinned baseline** in blue, and settings that differ from it in orange.
- **Categorical identity** (documents on the embedding map, telemetry series): eight fixed slots.

Every coloured mark carries a visible text label, so nothing is encoded in colour alone.

### Categorical slots
`web/src/lib/palette.ts` mirrors the eight `--viz-cat-*` tokens.
Slots are assigned in a stable order (for example documents by filename) and never cycled; a ninth entity folds to neutral ink instead of inventing a hue.
`catColor` reads the raw `--viz-cat-N` variables rather than Tailwind's aliases, because Tailwind drops theme variables its scanner never sees used and a dynamically built name is invisible to it.

### Validation
The palette was checked with a data-viz CVD and contrast validator against the app's actual surfaces, pure black and pure white, across all pairs in both modes.
The light theme re-steps each hue for white rather than flipping automatically.
The known warnings (dark red against aqua in the 6-8 CVD delta-E band, light aqua and some light categorical slots under 3:1 contrast) are accepted only because of the text-label rule above.
The embedding map can only guarantee CVD-safe pairs for the first three slots, so hover isolation and a labelled legend carry identity there and colour reinforces it.

### Type and surfaces
Inter for body text, Oswald for display labels, JetBrains Mono for numbers and readouts, loaded from Google Fonts in `web/index.html`.
Borders are hairlines; `glass` utilities give translucent surfaces for live or overlaid content only.
The shell is fixed-height with internal scroll regions (`overflow: hidden` on the page, `100dvh` root) so mobile never pans the whole viewport.

### Icons
Icons come from `@phosphor-icons/react`, imported per icon.

## Tech
Tailwind CSS v4 via `@tailwindcss/vite`, CSS custom properties, Phosphor icons, Google Fonts.

## Key files
- `web/src/global.css` - tokens, themes, type scale, base layer, custom utilities
- `web/src/lib/palette.ts` - categorical slot assignment
- `web/src/lib/stages.ts` - latency thresholds and source colour classes
- `web/src/app/ThemeToggle.tsx` - theme switch and persistence
- `web/src/app/headerControl.ts` - the shared look of the header controls
- `web/src/components/charts.tsx` - chart marks that follow the same colour rules

## Decisions and gotchas
- Green was dropped from the latency scale because green, amber and red failed the protanopia check; keyword moved from orange to aqua because orange collided with amber.
- The global `*` border-colour rule sits inside `@layer base`, because an unlayered rule outranks every Tailwind utility and silently broke `focus:border-*`.
- Do not add a hue for a concept that already has one; reuse the identity the interface already teaches.

## Related
- [Web UI](web-ui.md)
