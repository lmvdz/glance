# Gate wiring — fire the lens sequentially after the authoritative judge
STATUS: in-review
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/validator.ts

RE-LAND NOTE (2026-07-07): code cherry-picked back from orphaned worktree-research-recursive-orchestration (was merged in PR #96 as plan-only, code never reached main) — see reland/pr96-review-lens; STATUS held at in-review until that PR merges.

## Goal

Wire the lens into `validatorGate` so it runs **after** the authoritative criteria judge, only
when it can add value, without ever being able to block, stall, or degrade a land. This is the
concern that carries every RT1 correctness fix.

## Approach

In `validatorGate` (`src/validator.ts:325`), after the criteria judge resolves:

1. **Sequential, never concurrent.** The criteria judge runs alone and first (unchanged). Do NOT
   place it in any `Promise.all`/`allSettled` batch with lenses — co-locating N+1 `omp -p` spawns
   at its moment of need risks a provider 429/resource-exhaustion timeout on the *authoritative*
   call → fail-open `abstain` → a would-be-vetoed change lands. The sum-latency cost is the
   correct trade.
2. **Fire only when it can matter.** Skip the lens entirely if:
   - the master flag `OMP_SQUAD_LENS_REVIEW` is off (concern 06 supplies the read), OR
   - the criteria verdict is `veto` (already blocked) or `abstain`/`skipped` (no validated base to
     add an opinion to), OR
   - `selectLenses(diff, {...})` (concern 01) returns `[]` (docs/config-only).
3. **Cache-miss-only.** The panel result is computed only on a `gateCache` miss (`:281,330-333`),
   merged into the `ValidationRecord` **before** `gateCache.set`, and the record treated as
   immutable afterward (do not mutate a cached-by-reference record on a later land). The lens
   cache key is `${commit}:${tree}:${lensId}:${criteriaHash}` — it MUST include the criteria/task
   hash because `selectLenses` and the lens prompt depend on criteria text; a bare `commit:tree`
   key serves a stale verdict when criteria change.
4. **Failure isolation.** If more than one lens ever runs (future pool), use `Promise.allSettled`,
   each lens already `undefined`-on-failure from concern 02. For v1's single lens, still treat a
   rejected/`undefined` result as "no signal." Under no path may a lens failure propagate out of
   `validatorGate`.
5. Write results to `record.lensAdvisory` (may be `[]` or absent). Do NOT touch the `veto` return
   value — the lens is advisory; its verdict never changes what `validatorGate` returns to
   `runValidatorGate`.

## Cross-Repo Side Effects

`runValidatorGate` (`squad-manager.ts:2752`) already stamps `rec.dto.validation = record` before
the veto check and before `finalizeRun` — so `lensAdvisory` rides along with no new plumbing.
Concern 04 reads it from there.

## Verify

- Extend `src/validator.lens.test.ts` (or a new gate test) with a fake criteria judge + fake lens:
  - criteria `veto` → lens never fires (assert zero lens calls).
  - criteria `abstain` → lens never fires.
  - criteria `pass` + risky diff → lens fires once; `record.lensAdvisory` populated.
  - criteria `pass` + docs-only diff → lens never fires.
  - **lens throws / rejects → `validatorGate` still returns the criteria record intact and the
    land proceeds exactly as today** (the critical fail-open assertion).
  - cache hit → lens does not re-run; second land returns the same record without new spawns.
  - changing criteria text busts the lens cache (different `criteriaHash`).
- `bun test` green; `tsc` clean; run the full backend suite to confirm no regression in existing
  validator tests.
