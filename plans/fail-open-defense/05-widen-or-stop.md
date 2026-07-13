# Widen the union past the land path, or stop
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
BLOCKED_BY: 01
TOUCHES: (scoping only)

## Goal
Decide on evidence, not appetite, whether `GateVerdict` earns its way past the land path.

## Approach
The original 8-batch proposal was rejected because two red teams counted the defects and found the type
prevents ~25% of them at best, all in the fail-open-by-coercion class, on a surface that had just
stabilized. That count was made from history. Concern 01's harness produces a *forward* count: for each
of ~40 gates, does it return allow under any fault?

Read `bun scripts/gate-fault-report.ts` after 01 lands and 02/03/04 are green, then decide:
- Gates that fail under fault but sit outside the land path ⇒ candidates for conversion, ranked by
  blast radius.
- Gates that pass under every fault ⇒ leave them alone; converting them is ceremony.
- Gates whose fail-open is deliberate ⇒ they are already the harness's annotated exception list, which
  is the honest inventory this repo has never had.

Recommend build/no-build with the count attached. Do not widen because the type is nice.

## Cross-Repo Side Effects
None.

## Verify
A written recommendation citing per-gate fault results, reviewed against the harness output.
