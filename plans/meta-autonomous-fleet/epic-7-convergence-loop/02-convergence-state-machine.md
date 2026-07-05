# Convergence state machine

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/convergence.ts (new), src/convergence-oracle.ts, src/types.ts, src/convergence.test.ts (new)

## Goal (what is built)

The iteration state machine over injected deps: `plan → dispatch → validate → ratchet → decide`,
emitting a fresh `VerifiedState` (via `writeOracle`) each cycle. Pure policy, no live daemon — all
effects flow through a `ConvergenceDeps` interface, exactly like `OrchestratorDeps`. Unit-tested on
a converging fixture and a diverging fixture.

## Approach (how — cite real file:symbol attach points)

- Model on `src/orchestrator.ts:24` (`OrchestratorDeps`) — every edge is an injected function so
  the loop runs headless with fakes.
- New `src/convergence.ts`:
  - Define `ConvergenceDeps` per `DESIGN.md §2` (`plan`, `dispatch`, `validate`, `ratchet`,
    `writeOracle`, `confidenceFloor`, `budgetCap`, `epsilon`) plus the small `PlanFrontier` /
    `DispatchOutcome` shapes it passes between deps (keep them minimal — an id list + a settled
    flag; the real richness lives in Epics 1/2).
  - `runIteration(state: VerifiedState, deps): Promise<VerifiedState>` — one cycle:
    1. `frontier = await deps.plan(state.goalId, state)`
    2. `await deps.dispatch(frontier)`
    3. `{ gap, confidence, failures } = await deps.validate(state.goalId)`
    4. `{ allow, newRegressions } = deps.ratchet(state.__prevFailures, failures)` (carry prior
       failures on the state or a closure — pick one and document it)
    5. compute `decision`: `!allow` → `"escalate"` (regression, monotonicity broken);
       `confidence < deps.confidenceFloor` → `"escalate"` + `pendingEscalation=true`;
       `gap <= deps.epsilon` → `"converged"`; `budget.spent+1 >= deps.budgetCap` →
       `"budget-exhausted"`; else `"continue"`.
    6. build the next `VerifiedState` (increment `iteration`, `budget.spent`, set `gap`/`decision`/
       `updatedAt`), `await deps.writeOracle(next)`, return it.
  - `runToConvergence(initial, deps): Promise<VerifiedState>` — loop `runIteration` while the
    returned `decision === "continue"`; return the terminal state. (This is the in-process driver;
    the Stop-hook path in leaf 04 drives the *same* `runIteration` one turn at a time — keep
    `runIteration` the single reusable unit.)
- Do not read env or the filesystem directly for policy — thresholds come from `deps`.

## Scope boundary

Do NOT import `src/planner.ts` or `src/validator.ts` (they may not exist; leaf 05 supplies real
adapters). Do NOT implement the real ratchet (leaf 03 supplies it; here the `ratchet` dep is
injected and faked in tests). Do NOT touch the bash hook, `.claude/settings.json`, or
`runtime-settings.ts`. Do NOT add arming — the entrypoint (leaf 05) owns arm/disarm.

## Verify

```
bun test src/convergence.test.ts
```
Expected: green. Tests drive `runToConvergence` with fake deps — (a) **converging fixture**: a
`validate` fake that returns `gap` `3,2,1,0` on successive calls, `ratchet` always allows,
`confidence` high → terminal `decision === "converged"` at `gap 0`, and `writeOracle` captured 4
states with monotonically non-increasing `gap`; (b) **diverging fixture**: `validate` returns a
new failure on iteration 2 (`failures` grows), `ratchet` returns `allow:false` → terminal
`decision === "escalate"`, land NOT reached, and the loop stops that cycle; (c) **budget cap**:
`budgetCap = 2` with a never-closing gap → terminal `decision === "budget-exhausted"` after 2
iterations; (d) **low confidence**: `confidence < confidenceFloor` → `pendingEscalation === true`
and `decision === "escalate"`. Also `bun run typecheck` clean.
