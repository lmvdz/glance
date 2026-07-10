# Success-coupled efficiency accounting (matrix core)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/omp-graph/task-class-matrix.ts, src/omp-graph/attribution.ts, src/model-route.ts, src/attribution-scoreboard.ts, tests/

## Goal
The taskClass×model matrix carries (tokens, cost, success) together with an honesty gate a
consumer cannot bypass: cells publish only when sample size, cost coverage, token coverage, and
variance clear thresholds; a cheaper-but-worse cell is flagged as a regression; the baseline is
the auto-selected champion, not a rotting hand file.

## Approach
- `modelFamily` (src/omp-graph/attribution.ts): add xai/grok family; add a `modelVariant(model)`
  that preserves the full id. Efficiency cells key on `taskClass × modelVariant`; family remains
  a display rollup only.
- Extend the matrix builder to accept `RunReceipt[]` alongside outcomes; join on agentId,
  **summing tokens across a unit's receipts** (multiple receipts per agentId: resume/re-spawn).
  Mirror the cost triple exactly: `medianTokensTotal`, `nWithTokens`, `tokensCoveragePct`.
- `CellMetrics.reproducible = n >= N_MIN && costCoveragePct >= T && tokensCoveragePct >= T &&
  varianceFloor` — varianceFloor false when candidate and baseline are saturated at the same
  rate (all-landed vs all-landed publishes nothing). Computed IN the builder.
- Success signal is composite: mergeRate AND vetoRate (validation === "veto" share) AND
  inRunReworkRate (already on the row). `flagEfficiencyRegression(candidate, baseline)` fires
  when cheaper (cost or tokens) AND (lower mergeRate under variance, OR higher vetoRate, OR
  higher reworkRate beyond EPS).
- Baseline: auto-champion per taskClass (best mergeRate, cost as tie-break, reproducible cells
  only). Optional pin file overrides; when a pinned or champion baseline cell degrades to
  insufficientData, emit an AttentionEvent (staleness), don't silently compare against a ghost.
- `routeModelForTaskClass` (src/model-route.ts) honors `reproducible` in addition to
  `insufficientData` (shadow mode unchanged).
- attribution-scoreboard: external HarnessSpend quarantine untouched; add nothing that divides
  external spend by a success it doesn't have.
- NO webapp/API surface in this concern — no consumer exists yet; enforcement is builder-level.

## Cross-Repo Side Effects
None.

## Verify
Unit tests: saturated-equal cells never flag; cheaper+higher-veto flags; family collapse test
proves 5.6-sol vs 5.6-luna and grok-vs-* comparisons are visible at variant granularity; join
sums tokens across multi-receipt agents; champion staleness emits the event. `bun test` green.
