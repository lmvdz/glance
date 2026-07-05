# Ratchet dep (no-regression monotonicity)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/convergence-ratchet.ts (new), src/land.ts, src/convergence-ratchet.test.ts (new)

## Goal (what is built)

The real `ratchet` dep the state machine (leaf 02) consumes: a per-iteration no-regression check
that forbids iteration N+1 from introducing a failure N did not have. It reuses the exact
monotonicity logic the post-merge regression gate already trusts, so the loop's "never undo a
verified gain" guarantee is the same one landing already enforces.

## Approach (how — cite real file:symbol attach points)

- `src/land.ts` already exports the two pure helpers the regression gate uses:
  - `extractGateFailures(output, fallback?)` (`src/land.ts:209`) — parses a failure-name set from a
    gate's raw output.
  - `decideRegressionGate(baseFailures, mergedFailures)` (`src/land.ts:219`) → `{ allow,
    newRegressions }` — allows when no *strictly new* failure appeared (pre-existing red baseline
    is fine).
- New `src/convergence-ratchet.ts`:
  - `ratchet(prevFailures: string[], currFailures: string[]) => { allow, newRegressions }` — a thin
    wrapper delegating to `decideRegressionGate(prevFailures, currFailures)`. This is the function
    leaf 02 injects as `deps.ratchet`.
  - `ratchetFromOutput(prevOutput: string, currOutput: string)` — convenience that runs
    `extractGateFailures` on each raw suite output first, then `decideRegressionGate`. Use this when
    the caller (leaf 05) has raw suite text rather than pre-parsed failure sets.
- Do NOT call `detectVerify`/`runGate` — those are NOT exported from `src/land.ts` (verified). The
  ratchet stays pure over failure sets; whoever runs the suite passes the output/sets in.

## Scope boundary

Do NOT run any test suite here, do NOT touch `applyRegressionGate` or the land flow in `src/land.ts`
(import the two exported helpers only — no edits to land.ts's own logic). Do NOT wire this into
`src/convergence.ts` (leaf 05's entrypoint injects it). No env reads.

## Verify

```
bun test src/convergence-ratchet.test.ts
```
Expected: green. Tests — (a) `ratchet(["a"], ["a"])` → `allow:true, newRegressions:[]` (no new
failure); (b) `ratchet(["a"], ["a","b"])` → `allow:false, newRegressions:["b"]` (new regression
blocks); (c) `ratchet(["a","b"], ["a"])` → `allow:true` (a failure was FIXED — always allowed);
(d) `ratchetFromOutput` with two raw strings containing distinct `FAIL`/failure markers reduces to
the same allow/block decision via `extractGateFailures`. Also `bun run typecheck` clean.
