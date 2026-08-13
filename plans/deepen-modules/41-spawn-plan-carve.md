# SpawnPlan — the pure first half of a 776-line constructor
STATUS: open
PRIORITY: p3
REPOS: omp-squad
COMPLEXITY: complex
TOUCHES: src/squad-manager.ts createWithId 6847–7623 (776 lines, 43 distinct this. fields), laneSource exemptions :7244, harnessFor :7630, makeDriver :7651, unresolvedBranchIds :7733, reconcileParallelResume :7777, spawnFleetBranch :7794, goal-overlap disclosure :7612
MODE: afk

## Goal
createWithId braids identity minting, lane policy, harness selection, branch reconcile,
goal-overlap disclosure and deps install into one method — a deep-module failure of the
constructor kind. STAGED carve only (round-3 verdict: do not attempt a whole-region move):
extract `SpawnPlan`, a pure input → resolved-spawn-decision value (id, branch, lane, harness,
model, worktree) from the first half; the second half stays as the effectful commit that
consumes the plan. The plan becomes table-testable (lane exemptions and harness selection are
policy, not effects). Re-measure the region after this and after concern 28 re-measures the
land lane before considering anything bigger.

## Provenance
Round-3 review, daemon agent region-map verdict on spawn/create (14 methods, 55 fields).
