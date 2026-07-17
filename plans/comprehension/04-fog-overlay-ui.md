# Fog overlay UI: tri-state HeatTree overlay + top-10 shortlist + heatPayload fixes
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03
TOUCHES: src/server.ts, webapp/src/lib/heatmap.ts, webapp/src/components/ui/HeatTree.tsx

## Goal
Comprehension debt rendered where the operator already looks (the Context Heat Graph), as an actionable top-10 shortlist plus a tri-state tree overlay — never an undifferentiated red wall — with honest disclosure copy. Includes two pre-existing heatPayload bugs in the endpoint this extends.

## Approach
1. **heatPayload fixes** (`src/server.ts`, ~L2950–2988): (a) repo filter uses `normalizeRepoPath` equality, not raw `===`; (b) `byFile` keys carry the repo component (or the payload is grouped per-repo) so same-named files across repos don't collapse. Adjust `webapp/src/lib/heatmap.ts` for the key shape. Regression tests for both.
2. **Overlay data**: fetch `/api/fog` alongside `/api/heat`; join in a pure `webapp/src/lib/heatmap.ts` helper (`attachFog(tree, fogEntries)`) so `HeatTreeNode` gains `fog?: { debt, state, lastSeenAt? }`.
3. **Rendering** (`HeatTree.tsx`):
   - Toggle "Fog" next to the existing heat mode. Tri-state: `never-seen` = hatched pattern (distinct from red); `seen-current` = clear/dimmed; `stale` = ramp by `debt`.
   - When `repoHasHistory` is false: render the "no view history yet — fog appears once views are recorded" empty state, NOT the ramp.
   - **Top-10 debt shortlist as the headline** above the tree: file, debt, "last seen X ago / never", click focuses the tree node.
   - Disclosure line (small, persistent while fog mode active): "view activity is recorded to compute this overlay · team-level, renames reset history".
   - Folder aggregation: max of children's debt (not sum — a folder of many small unseen files shouldn't outrank one heavily-churned unseen file; note the choice in a comment).
4. Keep every decision (tri-state mapping, aggregation, shortlist ranking) in `heatmap.ts` pure helpers with tests; `HeatTree.tsx` stays a renderer.

## Cross-Repo Side Effects
None.

## Verify
`cd webapp && bun test && bunx tsc --noEmit` green. Root `bun test` green (heatPayload regressions). Manual (scratch-daemon): seed receipts across 2 repos with same-named files → no collapse; fog toggle shows hatch/clear/ramp distinctly; empty state before any attention events.

## Resolution
Shipped: f06686b (merged 11ced09) — heatPayload repo-normalize + repo-keyed `byFile` fixes, `attachFog`/`coldStartRepos`/`topFogDebt`/tri-state rendering, top-10 shortlist headline, disclosure copy.

Review verdict: FAIL → fixed by mount (batch-3 review). The shipped overlay had NO render site: GRAPH-FOLD.md retired the old "Context Heat Graph" page (`HeatPanel.tsx`, deleted) before this concern's fog toggle existed, and nothing in the post-fold app shell ever mounted `HeatTree` with fog mode reachable — an operator had no path to the tri-state comprehension-debt read this whole concern built. Fixed in the batch-3 fixer round: a new `fog` nav item (`webapp/src/components/FogView.tsx`, wired into `App.tsx`'s view switch, `WorkbenchPane.tsx`'s `NAV_ITEMS`, and the ⌘K palette's `NAV_ROWS`) mounts `HeatTree` with `initialFogMode` on. Deliberately NOT a resurrection of the retired `HeatPanel` — the old page's collision/flapping-agent callouts stay folded into Needs-you per GRAPH-FOLD §1; this view's only job is the fog read. The dead `heat` key's alias to `omp-graph` (GRAPH-FOLD.md §3) is UNCHANGED — `fog` is a new view, not a fold destination.

Also fixed in the same round (04 minor): `coldStartRepos`/`topFogDebt`/`allFilesColdStart` (`webapp/src/lib/heatmap.ts`) and `HeatTree.tsx`'s `fogVisual` tested repo membership against RAW, un-normalized repo strings while `attachFog`'s own join already normalized both sides via `normalizeRepoKey` — a repo named with a trailing slash on one side of a join would pass `attachFog` but fail every cold-start check. All four now normalize on both sides; regression tests with a trailing-slash repo added in `heatmap.test.ts` and `HeatTree.test.tsx`.
