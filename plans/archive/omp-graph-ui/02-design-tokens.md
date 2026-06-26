# Design tokens + fonts — port piyaz's palette into the SPA
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/index.css, webapp/package.json

## Goal
Replace the SPA's default shadcn oklch-neutral token block with piyaz's "Raycast near-black"
design system so every shadcn component and the canvas painter share one source of truth.

## Approach
1. **Fonts.** Add `@fontsource-variable/inter` + `@fontsource-variable/geist-mono` to
   `webapp/package.json` deps. Import them at the top of `index.css` (piyaz `app/globals.css:2-3`).
2. **`@theme` block.** Port piyaz's `@theme` palette verbatim into `webapp/src/index.css`
   (`app/globals.css:5-72`): `--color-base/-2/surface/surface-raised/surface-hover`, borders,
   `--color-text-*`, `--color-accent*`, status colors (`--color-done/progress/todo/planned/…`),
   `--color-glyph-*`, depth + glow shadows, `--sidebar-w/--rail-w/--row-h/--topbar-h`, fonts.
3. **Light mode.** Port the `html.light` override block (`app/globals.css:78-150`). Replace the
   SPA's `@custom-variant dark (&:is(.dark *))` convention with piyaz's **default-dark + `html.light`**
   model (the canvas's `getCanvasTheme()` keys off `document.documentElement.classList.contains("light")`,
   `graphConstants.ts`).
4. **shadcn bridge.** Keep shadcn's semantic var names (`--background`, `--foreground`, `--primary`,
   `--border`, `--muted-foreground`, `--ring`, …) but **remap their values to the piyaz tokens**
   (e.g. `--background: var(--color-base)`, `--card: var(--color-surface)`,
   `--primary: var(--color-accent)`, `--border: var(--color-border)`). This lets existing shadcn
   `button.tsx` etc. inherit the piyaz look with zero component edits.
5. **Atmosphere + chrome.** Port the body radial-glow, SVG `feTurbulence` noise overlay, custom thin
   scrollbars, `::selection`, `.text-gradient`, `.glow-card`, the conic `@property --angle`
   animated border, and `.prose-spec` markdown styles (`app/globals.css:200-803`). Drop the
   `#__next`-scoped noise selector → retarget to `#root` (Vite mount point) or `body`.
6. Set `html { font-family: var(--font-body) }` and the font-feature-settings block (`:…`).

## Cross-Repo Side Effects
None outside `webapp/`. Existing `webapp/src/App.tsx` Button keeps working, now piyaz-styled.

## Verify
- `cd webapp && bun run build` succeeds; emitted CSS contains `--color-accent` and `--color-base`.
- Dev-run `webapp`: background is near-black `#07080a`, accent is indigo `#818cf8`, the scaffold
  Button reads as a piyaz surface button; toggling `html.light` flips to the light palette.
- `tests/webapp.test.ts` gate stays green.

## Resolution
Ported piyaz @theme palette + atmosphere/scrollbars/glow into webapp/src/index.css (default-dark + html.light), added Inter/GeistMono fonts, bridged shadcn semantic tokens onto piyaz vars. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
