# Merged-result gate integration
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land.ts, tests/land-regression-gate.test.ts, tests/land-autoresolve.test.ts
PLANE: OMPSQ-400 — https://app.plane.so/inkwell-finance/browse/OMPSQ-400/

## Goal

When `OMP_SQUAD_REGRESSION_GATE=1`, run the full repo verification command against the branch merged onto current main and block the land if it introduces failures not already present on the base.

## Approach

- Add a local `regressionGateEnabled()` helper in `src/land.ts` using `process.env.OMP_SQUAD_REGRESSION_GATE === "1"`.
- Reuse `detectVerify(repo)` for the full-suite command. Do not reuse `opts.verify` for this new gate; feature acceptance can be narrower than the full suite.
- Build one helper that runs after a successful merge and before the land result is finalized:
  - If the flag is off, return success without running anything.
  - If `detectVerify(repo)` returns undefined or empty, return success.
  - Run the full command on the merged main via `runGate()`.
  - If merged passes, return success and include a concise detail suffix.
  - If merged fails, reset main to `head0`, run the full command on base, compare extracted failure sets with the pure function from concern 01.
  - If new regressions exist, keep main reset and return a blocking `LandResult` whose detail names the new failures and includes truncated output.
  - If no new regressions exist, re-merge using the existing `reMerge` callback; if re-merge fails, block as today's red-baseline path does.
- Replace the current binary red-baseline branch inside `verifyMerged()` with this helper while preserving existing acceptance-gate behavior when the new flag is off.
- Apply the same helper in `attemptAutoResolve()` after the fast-forward merge and before `reviewer()` approval. Auto-resolved conflict lands must not bypass the full-suite regression gate.
- Keep rollback semantics unchanged: failed merged checks reset only the main checkout to `head0`; the branch/worktree keeps its commits.

## Cross-Repo Side Effects

None.

## Verify

- Add a real-git temp-repo integration test using the existing `tests/land-*.test.ts` fixture style.
- Test script shape:
  - Minimal `package.json` with `check` and `test` scripts plus `bun.lock` so `detectVerify()` chooses Bun.
  - A deterministic gate script emits Bun-like `(fail) base.test.ts > known` when `BASE_RED` exists and `(fail) new.test.ts > introduced` when `NEW_RED` exists; exits non-zero if either marker exists.
- Required cases:
  - Flag unset + branch introduces `NEW_RED` while acceptance `verify: "true"` passes => current behavior preserved; land allowed.
  - Flag on + green base + branch introduces `NEW_RED` => blocked; repo `HEAD` equals `head0`.
  - Flag on + base has `BASE_RED` + clean branch => allowed; detail mentions red-baseline allowance.
  - Flag on + base has `BASE_RED` + branch adds `NEW_RED` => blocked; detail names `new.test.ts > introduced`; repo `HEAD` equals `head0`.
  - Flag on + base has `BASE_RED` + branch fixes it => allowed.
- Add or extend auto-resolve coverage so a conflict-resolved branch that introduces a new full-suite failure is rolled back before reviewer approval.