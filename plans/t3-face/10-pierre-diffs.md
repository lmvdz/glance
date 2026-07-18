# Pierre diffs — one t3-grade diff renderer, behind a size spike

STATUS: done
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 01, 08
TOUCHES: package.json, .size-limit.json (maybe), src/modules/fleet/IntervenePane.tsx (diff block), src/modules/ai/components/PlanDiffReview.tsx, src/modules/fleet/diffs/* (new), vite.config.ts (worker wiring)

## Goal

Fleet IntervenePane and the AI plan-review diff render through one `@pierre/diffs` `CodeView` surface with t3's theme bridge (pierre-light/dark mapped onto `--card`/`--background`), split/unified toggle, and line-selection→review-comment annotations feeding the composer. Reduces three diff UIs to two (editor CodeMirror-merge stays — different job, upstream-owned).

## Approach

**Gate this concern on a measured spike first** (NOTE load-bearing after C09: total client JS is already at the 1.5MB size-limit edge post-timeline, so pierre+shiki almost certainly needs the fallback path or an explicit budget bump — measure early) (red team: package is real — npm 1.2.12, Apache-2.0, clean `./react` export, react 19 peer — but 7 MB unpacked, depends on `shiki ^3||^4`, and shiki is absent from the fork today; the fork's `.size-limit.json` caps total client JS at 1500 KB gzip over `dist/assets/*.js` including lazy chunks).

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

## Decision record (2026-07-18) — spike run, pierre REJECTED, escape hatch built

Spike numbers (measured, per Approach step 1): baseline main = **1457.25 KB gzip / 1500 KB budget** (~42.75 KB headroom). Naive `@pierre/diffs`+shiki behind a lazy import = **3.44 MB gzip (+~1.9 MB)** — shiki's string-keyed `bundledLanguages` lookup defeats Rollup tree-shaking, retaining ~150 grammar chunks regardless of requested langs (a single hardcoded .ts diff still shipped Cobol and Wolfram), plus a 225 KB-gzip oniguruma wasm chunk via a dead ternary branch. Wasm-stubbed "shiki diet" via resolve.alias = **3.21 MB, still +~1.7 MB**; a real diet requires forking `@pierre/diffs`'s `shared_highlighter.js` onto shiki's fine-grained bundle API — out of scope. **Decision: escape hatch (b).**

Built as glance-desktop PR #38 (stacked on #34, retargeted to main at merge), MERGED 2026-07-18: shared `src/modules/fleet/diffs/` renderer (parseUnifiedDiff + lineDiff + toSplitRows, DiffFile, DiffViewToggle), token theme-bridge in t3face.css, fleet IntervenePane + AI PlanDiffReview consolidated onto it (three diff UIs → two), line-selection feeds concern 08's persisted `useSteerDraftStore`, raw-text fallback never throws. No new dependency.

**Size budget: Lars-approved bump 1500 → 1512 KB** ("i give u permission", 2026-07-18, covering the presented merge queue incl. this bump; isolated `build(size):` commit on #38). Base #34 sat at 1498.9/1500; the feature costs +2.4 KB; fitting without the bump meant gutting split-view + line-selection. Merged pristine gate: 1.50/1.51 MB green.

Deferred to concern 13: WebKitGTK live render smoke; keyboard a11y for line selection (mouse-first, arrow-nav deferred, rationale in code). Taste calls parked: split-view alignment on unbalanced hunks; prefix/suffix lineDiff renders a trailing append as tail-replace (exact for plan-apply's localized edits); hand-rolled CSS segmented toggle vs shadcn ToggleGroup (saved ~1.9 KB).
