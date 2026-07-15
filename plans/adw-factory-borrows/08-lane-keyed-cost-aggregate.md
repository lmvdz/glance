# Lane-keyed O(1) cost aggregate
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/cost-aggregate.ts (new), src/receipts.ts, src/cost-gate.ts, tests/cost-aggregate.test.ts (new)
BLOCKED_BY: 02

## Goal
An incremental, enforce-safe cost projection — O(1) read at spawn time, keyed `(model, tier, lane)` with a lane-agnostic fallback — replacing the async full-scan `readAllReceipts` path that cost-gate.ts's own header names as the reason enforce is stubbed to shadow.

## Approach
- This closes the deferral `src/cost-gate.ts:6-8` records ("Enforce mode … deliberately deferred: it needs an O(1) $ ledger") — cite plans/policy-and-cost-gates C-COST as the parent when filing (red-team M2).
- `src/cost-aggregate.ts` (new): a rolling aggregate document per stateDir (follow the tiny-JSON-per-stateDir convention), updated synchronously on each receipt write in `src/receipts.ts`: per key `model|tier|lane` (lane from `RunReceipt.lane`, concern 02) keep `{attempts, landed, costUsdSum, windowStart}` with a 30-day rolling window (match the model-route matrix window). Also maintain the lane-agnostic `model|tier` roll-up.
- Why lane-keyed before any enforce (red-team S8, verified): `projectCost` aggregates all history for `(model, tier)`; enforcing a chore-lane ceiling against a projection dominated by feature-lane spend denies wrongly on arrival — and chore contributes the fewest samples, compounding it. Fallback discipline: below `OMP_SQUAD_COST_MIN_SAMPLE` on the lane-keyed cell, fall back to the lane-agnostic cell; below min-sample there too, verdict is silent (existing behavior).
- `projectCost` gains a fast path: read the aggregate when present, keep the full-scan as the rebuild/backfill path (a `rebuildCostAggregate(stateDir)` invoked on first run or on schema-version mismatch — receipts remain the source of truth; the aggregate is a derived cache, corruption-safe by rebuild).
- No behavior change to verdicts in this concern: same shadow posture, new data shape underneath.

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/cost-aggregate.test.ts` — receipt write updates the right cells; window expiry; rebuild from receipts equals incremental state (property test over a receipt sequence); lane fallback ladder.
- Scratch daemon: run two units in different lanes, inspect the aggregate doc, confirm both keys present and the roll-up matches the scoreboard's `costPerLandedChange` for the same window.
