# Pierre diffs — one t3-grade diff renderer, behind a size spike

STATUS: open
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 01, 08
TOUCHES: package.json, .size-limit.json (maybe), src/modules/fleet/IntervenePane.tsx (diff block), src/modules/ai/components/PlanDiffReview.tsx, src/modules/fleet/diffs/* (new), vite.config.ts (worker wiring)

## Goal

Fleet IntervenePane and the AI plan-review diff render through one `@pierre/diffs` `CodeView` surface with t3's theme bridge (pierre-light/dark mapped onto `--card`/`--background`), split/unified toggle, and line-selection→review-comment annotations feeding the composer. Reduces three diff UIs to two (editor CodeMirror-merge stays — different job, upstream-owned).

## Approach

**Gate this concern on a measured spike first** (red team: package is real — npm 1.2.12, Apache-2.0, clean `./react` export, react 19 peer — but 7 MB unpacked, depends on `shiki ^3||^4`, and shiki is absent from the fork today; the fork's `.size-limit.json` caps total client JS at 1500 KB gzip over `dist/assets/*.js` including lazy chunks).

1. **Spike (do first, report number):** install `@pierre/diffs`, wire a minimal `CodeView` behind a lazy import, run `pnpm size`. If it fits (or fits with a shiki diet — JS engine + minimal grammar set + lazy-load), proceed. If it blows the budget, either (a) request a `.size-limit.json` bump — **Lars's explicit OK required**, per 00-overview — or (b) fall back to the escape hatch: t3-restyle the existing hand-rolled fleet diff renderer + PlanDiffReview with the diff theme-bridge CSS only, no new dep. Record the decision in the concern before building.
2. **Data**: the daemon serves unified-diff strings — compatible with `lib/diffRendering.ts`'s `getRenderablePatch` → `@pierre/diffs/utils/parsePatchFiles` flow (port that helper + `compactPartialHunkOffsets`, MIT/Apache notices as applicable). Raw-text fallback on parse failure.
3. **Worker wiring**: t3 runs pierre through a `DiffWorkerPoolProvider` whose source is NOT in the `/tmp/t3` cache — **re-fetch it from pingdotgg/t3code before implementing**. Wire pierre's worker entrypoints via Vite `?worker`.
4. **Theme bridge**: port t3's `.diff-panel-viewport`/`.diff-render-file` CSS mapping pierre surfaces onto the t3face tokens; file-status colors from pierre's own `--diffs-addition-base` etc. Add to concern 01's t3face.css (or a co-located diff CSS module).
5. **Host**: fleet diff block + PlanDiffReview render `CodeView`; DiffPanel-style split/unified `ToggleGroup` + wrap switch + file combobox; line-selection annotations feed the composer's review-comment draft (ties to concern 08's draft store).

## Cross-Repo Side Effects

None (unified-diff strings already served).

## Verify

- Spike: `pnpm size` number recorded in-concern; pass/fallback decision documented before build.
- Live: a real unit diff renders in split and unified; large diff lazy-loads without blocking the timeline; parse-failure input falls back to raw text; line-select creates a review comment in the composer tray.
- WebKitGTK: diff surface renders correctly on Linux (concern 13 matrix).
- `pnpm lint && check-types && vitest run && build` green; size gate green (or bumped with recorded OK).
