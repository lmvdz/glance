# Pre-land regression gate research brief

## Goal
Add an opt-in pre-land full-suite regression gate so `omp-squad` only keeps a land if the branch, merged onto current main, does not introduce failures beyond the base branch's existing red baseline.

## Existing repo map
- `src/land.ts`
  - `landAgent()` serializes through `withRepoLandLock()`, so merged-main checks already run under the same per-repo lock that protects merge/reset sequences.
  - `runGate(cmd, cwd)` is the local verification runner: shell command, cwd, timeout, combined output. Reuse this shape; it is currently private.
  - `landAgentLocked()` captures `head0`, resolves `gate = opts.verify ?? detectVerify(repo)`, merges the branch, then `verifyMerged()` runs the current gate on merged main.
  - Existing red-baseline logic is binary only: if merged gate fails, reset to `head0`, run the same gate on base, and if base also fails, re-merge and allow. Lines 237-240 explicitly name the gap: it cannot tell "still red" from "redder".
  - `attemptAutoResolve()` has its own post-merge verification path and currently blocks on any non-zero gate; the regression gate must share the same helper or auto-resolved lands will diverge.
- `src/proof.ts`
  - `runProof()` runs the feature acceptance command in the isolated worktree and records a fresh proof fingerprint.
  - `proofGate()` blocks stale/missing/failed pre-merge proofs. This is separate from the requested merged-result gate and should stay separate.
- `src/intake.ts`
  - `detectVerify(repo)` is the repo-native full verification command detector. For this repo it resolves to `bun run check && bun run test` from `package.json` scripts and `bun.lock`.
- `src/squad-manager.ts`
  - `landFeature()` passes per-feature `pf.acceptance` into `landAgent()`.
  - Single-agent `land()` calls `landBranch()` without `verify`, so `land.ts` auto-detects the repo command.
  - `runMainGate()` for Observer already parses Bun-style `(fail) ...` lines and falls back to the first non-empty error line.
- Tests already in place:
  - `tests/land-base-gate.test.ts` pins the current binary red-baseline behavior with real git repos and marker files.
  - `tests/land-verify.test.ts`, `tests/land-autoresolve.test.ts`, `tests/land-lock.test.ts`, and `tests/autoland.test.ts` provide fixture style and seams.
  - Env-flag tests save/restore `process.env` in `afterEach`; follow that pattern for `OMP_SQUAD_REGRESSION_GATE`.

## External/prior-art patterns
- GitHub Merge Queue validates a temporary branch containing the PR applied to the latest target branch plus earlier queued changes; failed required checks remove the PR from the queue. Source: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- Expected-failure systems keep known failures from making the suite red while still surfacing unexpected passes/failures. Pytest describes `xfail` as an expected failing test, with `XPASS` reported when it unexpectedly passes. Source: https://docs.pytest.org/en/stable/how-to/skipping.html
- Bun has a JUnit reporter (`bun test --reporter=junit --reporter-outfile=...`) for stable machine-readable test identities, but its docs say per-test stdout/stderr is not included. Source: https://bun.com/docs/test/reporters

## Transferable patterns
1. **Speculative merged-result validation**
   - Test the exact tree that would become main, not the feature worktree alone.
   - `src/land.ts` already does this for the acceptance command; extend that point rather than adding a second orchestration path.
2. **Red-baseline set algebra**
   - Treat failing tests as sets: `newRegressions = mergedFailures - baseFailures`.
   - Allow when merged is green or when `newRegressions` is empty.
   - Block when base is green and merged has failures, or when merged has any failure not present on base.
3. **Stable failure identity**
   - Normalize volatile output before comparing: strip Bun duration suffixes the way `stableFailure()` already does.
   - Prefer explicit test identities from `(fail) ...` lines for this repo's Bun suite.
   - If a non-zero command yields no parseable test identities, use a conservative synthetic identity from the first meaningful output line or command name; never turn an unparseable failure into an empty set.
4. **Default-off cutover**
   - `OMP_SQUAD_REGRESSION_GATE` should be opt-in (`=== "1"`) to preserve current behavior.
   - The flag gates only the new full-suite regression check. Existing proof/acceptance gates remain as-is.
5. **One gate runner, two decisions**
   - Reuse `runGate()` execution and `detectVerify()` command selection.
   - Add a pure decision function separate from git/process work so set logic is deterministic and unit-testable.

## Concrete application points
- `src/land.ts`
  - Add exported pure decision API, e.g. `decideRegressionGate(baseFailures: Set<string> | string[], mergedFailures: Set<string> | string[])` returning `{ allow: boolean; newRegressions: string[] }`.
  - Add failure extraction near `truncate()`/`runGate()` or extract shared parsing from `src/squad-manager.ts`/`src/observer.ts` later. Minimal first pass can parse Bun `(fail)` lines plus first-line fallback.
  - Add `regressionGateEnabled()` using `process.env.OMP_SQUAD_REGRESSION_GATE === "1"`.
  - In `verifyMerged()`, after the current acceptance gate passes/allows, run the full command from `detectVerify(repo)` when the env flag is on. If it fails, reset to `head0`, run the same full command on base, compare failure sets, block on new failures, otherwise re-merge and allow with detail naming red-baseline allowance.
  - Apply the same helper in `attemptAutoResolve()` after the ff merge and before reviewer approval; otherwise conflict-resolved lands bypass the new semantics.
- `src/intake.ts`
  - No change likely needed: `detectVerify()` already identifies full-suite commands.
- `src/squad-manager.ts` / `src/observer.ts`
  - Existing `(fail)` parsing and duration normalization are reusable concepts. Avoid moving code unless it reduces duplication without widening scope.
- `README.md` or `docs/operations.md`
  - User-facing env flag should be documented when production code is added: `OMP_SQUAD_REGRESSION_GATE=1` enables pre-land full-suite merged-result regression gating.

## Test shape for the implementation phase
- Pure unit tests:
  - base `[]`, merged `[]` => allow, no new regressions.
  - base `[]`, merged `["a"]` => block, `newRegressions=["a"]`.
  - base `["a"]`, merged `["a"]` => allow.
  - base `["a"]`, merged `["a","b"]` => block, `newRegressions=["b"]`.
  - base `["a","b"]`, merged `["a"]` => allow; fixing one baseline failure is not a regression.
  - duplicate/unsorted inputs produce deterministic sorted `newRegressions`.
- Land-path integration test:
  - Real temp git repo + branch worktree, matching existing land tests.
  - Set `OMP_SQUAD_REGRESSION_GATE=1`; restore it in `afterEach`.
  - Use normal `verify: "true"` or omit acceptance so the new full-suite gate is the thing under test.
  - Put a minimal `package.json` + `bun.lock` in the temp repo so `detectVerify()` returns a controlled script.
  - Controlled script should emit Bun-like `(fail) base.test.ts > known` when `BASE_RED` exists and `(fail) new.test.ts > introduced` when `NEW_RED` exists, then exit non-zero if either exists.
  - Case A: base has `BASE_RED`, branch adds unrelated file => land allowed.
  - Case B: base has `BASE_RED`, branch adds `NEW_RED` => land blocked and repo `HEAD` reset to `head0`.
  - Case C: flag unset with same branch adding `NEW_RED` => current behavior preserved.

## Risks / decisions for planning
- **Acceptance vs full-suite duplication:** Feature lands may already pass `pf.acceptance`; the regression gate should still use `detectVerify(repo)` under the env flag because the acceptance command can be narrower than the full suite.
- **Unparseable failures:** Empty failure sets on non-zero output would accidentally allow regressions. Use a synthetic failure identity fallback.
- **Force lands:** `landAgent()` does not receive a force flag; force currently bypasses proof, not necessarily merged verification. Keep the regression gate inside `land.ts` so force cannot silently skip it unless an explicit future policy says otherwise.
- **Re-merge failure after base comparison:** Existing red-baseline code blocks if re-merge fails. Keep that behavior.
- **Auto-resolve reviewer order:** Run regression gate before reviewer approval; a reviewer should inspect only a candidate that already passed deterministic gating.

## Abstracted concepts to drive the plan
- Speculative merge validation.
- Red-baseline differential failure sets.
- Stable failure identities with conservative fallback.
- Default-off safety flag for behavioral cutover.
- Shared deterministic decision core plus thin git/process integration.
