# Regression decision core
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/land.ts, tests/land-regression-decision.test.ts
PLANE: OMPSQ-399 — https://app.plane.so/inkwell-finance/browse/OMPSQ-399/

## Goal

Provide a pure, exported decision core for red-baseline gating: compare base failures with merged failures and return allow/block plus the deterministic set of new regressions.

## Approach

- Add a small exported function in `src/land.ts`, near the gate helpers:
  - Inputs: arrays or sets of normalized failure identities.
  - Output: `{ allow: boolean; newRegressions: string[] }`.
  - Treat duplicate inputs as one failure.
  - Sort `newRegressions` for stable details and tests.
- Add failure extraction next to `runGate()`/`truncate()` only if needed for this pure layer:
  - Parse Bun-style `(fail) <test name>` lines.
  - Reuse the duration-suffix normalization concept from `stableFailure()` in `src/observer.ts`.
  - If command exit is non-zero and no test identity parses, produce a conservative synthetic identity from the first non-empty output line or the command name. Never return an empty failure set for an unparseable failed run.
- Keep this concern free of git, merge, reset, env-flag, or process orchestration changes. Those belong to concern 02.

## Cross-Repo Side Effects

None.

## Verify

- Add deterministic unit tests covering:
  - base `[]`, merged `[]` => allow, no new regressions.
  - base `[]`, merged `["a"]` => block with `newRegressions=["a"]`.
  - base `["a"]`, merged `["a"]` => allow.
  - base `["a"]`, merged `["a", "b"]` => block with `newRegressions=["b"]`.
  - base `["a", "b"]`, merged `["a"]` => allow.
  - duplicate and unsorted failures produce a sorted unique result.
  - volatile Bun duration suffixes do not create distinct identities.
  - non-zero unparseable output still yields one fallback failure identity.
- Run only the new decision test file before handing off to concern 02.

## Resolution

Closed 2026-06-30 via OMPSQ-399 (https://app.plane.so/inkwell-finance/browse/OMPSQ-399/). Commits: c39de16.
Added the pure failure-set decision helper, conservative failure extraction, and deterministic unit coverage.