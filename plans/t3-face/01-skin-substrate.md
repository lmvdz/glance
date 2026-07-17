# Skin substrate — the t3 token set, typography, and motion as the app default

STATUS: done
PRIORITY: p0
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/styles/t3face.css (new), src/styles/globals.css, src/main.tsx, src/settings/main.tsx, components.json, UPSTREAM.md, package.json

## Goal

The whole app — both webview entrypoints — renders in t3code's visual system: derived alpha palette, DM Sans Variable + JetBrains Mono, t3's radius scale, duty-cycled status animations, unison skeleton sweep, surface grain, composer glass, 6px overlay scrollbars, and the `.chat-markdown` typography system. Non-default themes (dracula, nord, …) keep working via engine fallthrough.

## Approach

Reference sources are cached at `/tmp/t3/index.css` (t3code apps/web/src/index.css; re-fetch from pingdotgg/t3code if evicted). Build-verified constraints from the red-team round — do not re-litigate them:

- `@theme` blocks are ONLY processed in the CSS graph reachable from the Tailwind root (`globals.css`). A later-imported file's `@theme` passes through as an inert at-rule and utilities like `bg-warning` silently generate nothing.
- Font utilities bake literals (`font-sans` → `Inter Variable` hardcoded); overriding `--font-sans` later does nothing. ~7 components use explicit `font-sans`/`font-heading` (kbd, dialog, sheet, empty, etc.) — inheritance-only delivery ships mixed typography.
- Bare `:root`/`.dark` custom-property redeclarations in a later-imported un-layered file DO win by source order, including for `@theme inline`-mapped vars (`--primary`, `--radius`).

Therefore:

1. **New `src/styles/t3face.css`** (fork-owned, MIT header crediting T3 Tools Inc.), imported in `src/main.tsx` AND `src/settings/main.tsx` immediately after `globals.css`. Contents: `:root`/`.dark` t3 palette overrides (derived alpha palette: light secondary/muted/accent = black/4%, border black/8%; dark bg = neutral-950 + 5% white, card = bg + 2% white, border white/6%; primary/ring `oklch(0.488 0.217 264)` light / L 0.588 dark); values for the four status token families; `@font-face` for DM Sans Variable (new dep `@fontsource-variable/dm-sans`); keyframes `status-pulse`/`status-ping` (steps(6)/steps(8) duty-cycled — copy exactly) and `skeleton` sweep with `background-attachment: fixed`; `surface-grain` feTurbulence data-URI class at 0.035 opacity; the composer glass suite (`chat-composer-glass`, lower-chrome, shared-blur, `@supports not (backdrop-filter…)` solid fallback); global 6px transparent-track scrollbars + hidden/thin variants; the `.chat-markdown` typographic system; `.no-transitions` theme-switch guard. Everything namespaced or scoped so upstream classes are untouched.
2. **Minimal `globals.css` edits** (already fork-diverged — extending an existing conflict file, keep the diff hunks few and commented): in `@theme inline` — swap `--font-sans` to DM Sans Variable stack, register `--color-warning/-info/-success/-pending` (+ `-foreground` variants) mapped to `var(--warning)` etc., add `--radius-3xl/4xl` extensions and `--animate-status-pulse/status-ping/skeleton` names so utilities compile.
3. **WebKitGTK kill switch**: a single `t3face-flat` root class that disables grain + glass + fixed-attachment sweep in one place; document in the file header. Default off; flipped if Linux capture (concern 13) shows jank.
4. **`components.json` fix**: point `tailwind.css` at `src/styles/globals.css` (it references nonexistent `src/App.css` today), so any shadcn CLI use during this program targets reality.
5. **UPSTREAM.md**: add the skin-coverage manifest (enumerated upstream surfaces t3face intentionally styles: editor chrome, terminal, settings, spaces/tab bar, dialogs) + a rebase-runbook step: after every upstream rebase, screenshot-diff the manifest surfaces in both modes.

Do NOT touch `fonts.css` (pure `@font-face`, verified — no edit needed). Do not remove Inter (upstream components reference it until rebased; DM Sans wins via the `@theme` swap).

## Cross-Repo Side Effects

None.

## Verify

- `pnpm lint && pnpm check-types && pnpm vitest run && pnpm build` green; `pnpm size` unchanged ± font asset.
- Built CSS inspection: `.font-sans` emits DM Sans; `bg-warning`/`text-warning` generate real rules; `rounded-lg` still `var(--radius)`-driven.
- Live (`pnpm tauri dev`): main window AND settings window render DM Sans + t3 palette in light and dark; switching to dracula repaints (engine inline styles win over t3face.css); switching back restores t3 (fallthrough). No first-paint gray flash.
- Screenshot pair vs `/tmp/t3` reference values: background/card/border sampled colors match t3's within oklch rounding.

## Resolution

Shipped as glance-desktop draft PR #29 (branch `t3face/01-02-skin-substrate`, with concern 02). t3face.css ports the full skin; globals.css carries the `@theme` registration only. Gate green (515/515, lint/types/build); built-CSS assertions hold (DM Sans emitted, status utilities compile, radius chain intact, scrollbar override wins by order); palette fidelity cross-checked against `/tmp/t3/index.css` by the orchestrator (exact). +88 bytes gzip. Five deviations, all sound (`--alpha()`→oklch literal, `@utility`/`@variant`→plain classes, spec-required scrollbar un-hide, violet `--pending` per concern 07, standard skeleton sweep). Live visual acceptance deferred to concern 13 (needs spine + fleet re-key to be meaningful).
