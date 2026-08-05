# /api/metrics/impact + cohort rollups
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 05
TOUCHES: src/server.ts, src/impact/cohorts.ts (new), tests/impact-cohorts.test.ts (new)

## Goal
Fleet-readable impact data: per-unit snapshot reads and (repo, week) cohort rollups with measurability floors.

## Approach
- `/api/metrics/impact` in `SquadServer.handleObservability` beside `/api/metrics/learning-loop` (src/server.ts:1225); `boundedNumber` params; repo-scoped through `resolveGraphRepo` 403.
- Cohorts keyed **(repo, week landed)**, measured at W+4 — churn gravity differs per repo; never mix. Every rollup carries its gap fraction inside the same figure ("impact/$ over 7 of 19 units"); a cohort under the measurability floor (documented constant) renders as gap wholesale — this is the defense against selection-on-measurability, where ranking only the numeric subset quietly rewards greenfield work.
- Pure `buildCohortReport(snapshots)` reading only snapshot files (no git at read time); backfilled entries surface their "N of M reconstructed" line.

## Cross-Repo Side Effects
None.

## Verify
Route test (auth tier, 403 on foreign repo); cohort fixture with mixed gap/numeric units asserts gap fraction present in every aggregate and floor behavior.
