# Fog overlay UI: tri-state HeatTree overlay + top-10 shortlist + heatPayload fixes
STATUS: open
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
