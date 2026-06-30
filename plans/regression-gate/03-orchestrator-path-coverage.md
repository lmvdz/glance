# Orchestrator path coverage
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: tests/orchestrator.test.ts, tests/manager-autonomy.test.ts, tests/land-regression-gate.test.ts
PLANE: OMPSQ-401 — https://app.plane.so/inkwell-finance/browse/OMPSQ-401/

## Goal

Prove the orchestrator and manager land paths cannot bypass the new flag-gated `landAgent()` regression gate.

## Approach

- Prefer tests over production changes. The desired architecture is one shared `src/land.ts` primitive that all land paths already call.
- Confirm these paths remain covered:
  - Single-agent `SquadManager.land()` through `landBranch()`.
  - Feature landing `SquadManager.landFeature()` through `landAgent()`.
  - Orchestrator auto-land through `autoLandWorkflow()` → `this.land()`.
  - Auto-resolved conflict landing through `attemptAutoResolve()` from concern 02.
- Use existing protected seams where possible:
  - `landBranch()` override in manager tests for routing assertions.
  - Existing orchestrator fake deps for auto-land call counting.
  - Real-git land test from concern 02 for the actual block/rollback behavior.
- Do not add a second env flag check to `squad-manager.ts` or `orchestrator.ts` unless tests prove a path bypasses `landAgent()`.

## Cross-Repo Side Effects

None.

## Verify

- Add or extend tests to assert:
  - Manager single-agent land passes through the shared `LandOpts` path while the flag is set.
  - Feature land still passes acceptance command via `verify: pf.acceptance`, but the regression gate uses the full detected command from `detectVerify(repo)`.
  - Auto-land receives a blocking `LandResult` from the land primitive and records/parks it like other non-retryable land failures.
- Run the narrow affected tests only before final suite:
  - `bun test tests/land-regression-gate.test.ts tests/orchestrator.test.ts tests/manager-autonomy.test.ts`