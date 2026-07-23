# Accepted-state anchor: manifest, checkpoints, continuity, lineage projector
STATUS: done — merged via PRs #201/#212 (concern 08: 0bf3389, src/land-assessment/hook.ts); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 04
TOUCHES: src/land-assessment/manifest.ts, src/land-assessment/projection.ts, src/land-assessment/continuity.ts, src/land-assessment/manifest.test.ts

## Goal
Deltas alone cannot answer "what was module X's interface at commit A." This concern supplies the reconstruction strategy: an initial accepted-state manifest, periodic checkpoints, a lineage projector, and continuity detection for transitions that never flowed through glance.

## Approach
- `manifest.ts`: `RepositoryManifest` extraction — run the structural-delta analyzer's per-file extraction (04) over a full exact state (all TS files at one commit/tree) to produce entities + SnapshotFacts + multidimensional coverage; written through the store (07) as the anchor. Checkpoint cadence: on first enablement per repo, then every N accepted transitions (config, default 50) — bounds projection replay length.
- `projection.ts`: the lineage projector — `projectState(repoStateRef)` = nearest ancestor manifest/checkpoint + accepted ChangeObservations along the selected first-parent lineage; computes branch-scoped validity intervals at read time (the SCHEMA-V0 rule: intervals are projections, never primitives). Falls back to on-demand historical extraction (git show + 04's extractor) when the chain is broken, recording the fallback as a coverage note.
- `continuity.ts`: `ContinuityRecord` maintenance — compare last-indexed main against current (`isAncestor` + accounted-transition check); external/unobserved transitions (human pushes, force pushes, bot merges) flip status to `unknown` with a reason; reconcile-or-re-extract is the repair path (re-checkpoint at current tip). The temporal model never silently assumes completeness.
- Accepted-state discipline (C≠R): after a landed terminal, accepted facts come from extracting/reconciling R — this module owns that extraction; candidate observations are never relabeled.

## Cross-Repo Side Effects
None — consumed by projection tests (10) and later phases; no land-path changes.

## Verify
`bun test .../manifest.test.ts`: manifest extraction on a fixture repo; projection through a checkpoint + deltas equals direct extraction at the target commit (the anchor identity check); continuity flips to `unknown` on a simulated force-push and repairs via re-checkpoint; R-extraction after a squash-land differs from C's observations and wins as accepted state.
