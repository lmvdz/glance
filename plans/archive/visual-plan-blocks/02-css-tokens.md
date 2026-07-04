# --wf-* CSS token layer and scoped helper classes
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/index.css

## Goal

Add the `--wf-*` design-token layer the block renderer depends on, mapped onto the
webapp's existing palette and flipping correctly between light and `.dark`. Define
the block helper classes (`.wf-card`, `.wf-pill`, `.wf-muted`, `button.primary`,
and the diagram-skin variants) scoped so they never leak into the rest of the app.

## Approach

The webapp uses Tailwind v4 (`@tailwindcss/vite`); `webapp/src/index.css` has an
`@theme` block defining only `--font-*` and `--color-gray-950..700`, and dark mode
is the `.dark` class on `<html>` (see `webapp/src/context/ThemeContext.tsx`).

**Critical (verified):** Tailwind v4's `theme()` function is deprecated, and theme
variables are tree-shaken — `var(--color-white)`/`--color-blue-500` are NOT
guaranteed to exist unless used or declared `static`. So DO NOT write
`--wf-paper: theme(colors.white)` under a bare `:root{}`. Define tokens with
literals and the already-defined grays, inside `@theme` (so they're first-class),
with a `.dark` override block.

1. Add the token definitions. Light values in `@theme` (or `:root`), dark
   overrides under `.dark`:
   ```css
   @theme {
     /* ...existing... */
     --wf-paper: #ffffff;
     --wf-card: #f9fafb;            /* gray-50 */
     --wf-ink: var(--color-gray-900);   /* defined above → safe */
     --wf-muted: #6b7280;          /* gray-500 */
     --wf-line: #e5e7eb;           /* gray-200 */
     --wf-accent: #3b82f6;         /* blue-500 */
     --wf-accent-fg: #ffffff;
     --wf-accent-soft: #dbeafe;    /* blue-100 */
     --wf-warn: #f59e0b;           /* amber-500 */
     --wf-ok: #10b981;             /* emerald-500 */
     --wf-radius: 0.5rem;
   }
   .dark {
     --wf-paper: var(--color-gray-950);
     --wf-card: var(--color-gray-900);
     --wf-ink: #f3f4f6;
     --wf-muted: #9ca3af;
     --wf-line: var(--color-gray-700);
     --wf-accent-soft: rgba(59,130,246,0.18);
   }
   ```
   (Match the exact hex to the Tailwind palette the app already uses; the values
   above are the standard Tailwind colors referenced in `TaskDetail.tsx`.)
2. Define helper classes scoped under a `.wf-surface` container AND `.not-prose`
   so they don't collide with future Tailwind utilities and aren't polluted by
   `@tailwindcss/typography` `prose` (the markdown article is `prose`):
   ```css
   .wf-surface { font-family: var(--font-sans); color: var(--wf-ink); }
   .wf-surface .wf-card { background: var(--wf-card); border: 1.4px solid var(--wf-line); border-radius: var(--wf-radius); padding: 1rem; }
   .wf-surface .wf-pill { display:inline-block; background: var(--wf-card); border:1px solid var(--wf-line); color: var(--wf-muted); border-radius: 999px; padding: 0.1rem 0.55rem; font-size: 0.72rem; }
   .wf-surface .wf-pill.accent { background: var(--wf-accent-soft); color: var(--wf-accent); border-color: transparent; }
   .wf-surface .wf-muted { color: var(--wf-muted); font-size: 0.875rem; }
   .wf-surface button.primary, .wf-surface [data-primary] { background: var(--wf-accent); color: var(--wf-accent-fg); border:none; border-radius: var(--wf-radius); padding: 0.45rem 0.9rem; }
   .wf-surface h1,.wf-surface h2,.wf-surface h3,.wf-surface input,.wf-surface a { color: var(--wf-ink); }
   ```
   Add the diagram-skin variants too: `.wf-surface .diagram-panel`,
   `.diagram-card`, `.diagram-node` (bordered/padded boxes using the same tokens).
3. Keep the additions self-contained and clearly sectioned with a comment so the
   block CSS is easy to find.

## Cross-Repo Side Effects

None. Other concerns (04, 08) consume these tokens/classes via `var(--wf-*)` and
`className="wf-surface not-prose"`.

## Verify

- `grep -- '--wf-paper' webapp/src/index.css` and `grep -- '--wf-ink' webapp/src/index.css` succeed.
- `cd webapp && bun run build` succeeds (the CSS compiles — confirms no
  `theme()`/tree-shaking breakage).
- Manual: a `<div class="wf-surface not-prose"><div class="wf-card">x</div></div>`
  shows a bordered card whose colors invert when `.dark` is toggled on `<html>`.

## Resolution

Landed in 5d38ece (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
