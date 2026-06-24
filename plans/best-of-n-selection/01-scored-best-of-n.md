# Scored best-of-N selection for workflow fan-out

STATUS: in_progress
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/workflow/engine.ts, src/validate.ts, src/land.ts, README.md
BLOCKED_BY:

## Goal

Turn parallel fan-out from redundancy into a **tournament**: when N branches race one goal, evaluate every
passer with a numeric fitness and land only the **best**, instead of taking the first/any passer. This is the
evolved-antenna move (population → fitness → selection) applied to the fan-out omp-squad already has.

## Approach

1. **New join policy** in `src/workflow/engine.ts` `runParallel` (currently `engine.ts:104-131`). Add
   `best` (a.k.a. `select_best`) alongside `first_success` | `wait_all`:
   - Run all branches as today.
   - Among branches with `outcome === "succeeded"`, score each worktree (step 2).
   - The merge result = the **highest-scoring** branch's `NodeResult`; record the chosen branch + all scores
     into `ctx.vars.parallelResults` (already carries `{branch,outcome,text}` at `engine.ts:127` — extend with
     `score`) and the audit trail.
   - `succeeded` if ≥1 branch passed (same as `first_success` for the pass/fail decision); the *difference* is
     which branch's result propagates and lands.

2. **Scored gate** in `src/validate.ts`: the gate becomes `{ pass: boolean, score: number, axes: {...} }`
   instead of a bare boolean. `pass` = today's hard gate (tests/typecheck exit 0) — **immutable**. `score` =
   soft tie-breaker among passers. **v1 soft axis = diff size** (lines changed + files touched; smaller wins),
   mechanizing the AGENTS.md ponytail preference "shortest working diff wins".
   `ponytail:` single soft axis (diff size); add perf/lint/coverage axes when a real case shows diff-size alone
   mis-ranks.

3. **Land only the winner** — `engine.ts` merge hands the winning branch to the existing
   `landAgent`/`landFeature` (`src/land.ts`); losing branches are left for the worktree janitor to reap (no new
   cleanup path). `first_success`/`wait_all` land behavior is unchanged.

## Goodhart guard (why this doesn't evolve degenerate code)

The antenna article's tell: winners were **fabricated and flown**, not trusted on sim score alone. Code analog:
- The **hard gate is immutable** — the acceptance command is operator-supplied and run fresh against each
  worktree, so a candidate cannot win by deleting tests or weakening asserts (that fails the hard gate).
- Soft `score` **only breaks ties among hard-passers** — it can never promote a failing candidate.
- The Observer's existing `regression: <test>` check on main is the post-land "flight test".

## Cross-repo side effects
None. Internal to omp-squad. `first_success` and `wait_all` paths and their tests stay byte-for-byte behavior.

## Docs (ship with behavior — AGENTS.md)
README "Workflows" section documents shapes/policies; add `best` to the `join_policy` description there
(currently `wait_all | first_success`, README ~line 500). Same worktree, same land.

## Verify
- New `tests/best-of-n.test.ts` (deterministic, no model tokens): drive `runParallel` (or its join helper)
  with 3 stubbed branch results — two `succeeded` with different diff scores, one `failed`. Assert:
  (a) `best` selects the succeeded branch with the better score; (b) the failed branch can never be selected
  even if its score field is better (hard gate dominates); (c) `first_success` and `wait_all` outcomes are
  unchanged by the new code path.
- Gate (acceptance command for `--verify`): `bun run check && bun test`.

## Release (dispatch when the operator wants it — it's parked, not abandoned)

```bash
omp-squad add ~/sui/omp-squad --name best-of-n --thinking medium \
  --task "Implement plans/best-of-n-selection/01-scored-best-of-n.md: add join_policy:best to runParallel in src/workflow/engine.ts, a scored gate in src/validate.ts (pass + diff-size score), land only the winner, README + tests/best-of-n.test.ts per the doc." \
  --verify "bun run check && bun test"
```
