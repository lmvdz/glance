# Operator docs and final verification
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: README.md, docs/operations.md
PLANE: OMPSQ-402 — https://app.plane.so/inkwell-finance/browse/OMPSQ-402/

## Goal

Document the opt-in regression gate and run the required full repository verification before the feature is considered ready.

## Approach

- Add a short operator-facing note where existing automation/env flags are documented:
  - `OMP_SQUAD_REGRESSION_GATE=1` enables pre-land full-suite gating on the merged result.
  - Default is off.
  - On red baselines, only failures already present on base are allowed; new failures block and main is reset.
- Keep docs concise; no architecture essay.
- Do not change code in this concern.

## Cross-Repo Side Effects

None.

## Verify

- Run the final required gate from the user request:
  - `bun run check && bun test`
- If the suite fails, report the failing tests exactly; do not suppress, skip, or narrow the required gate.

## Resolution

Closed 2026-06-30 via OMPSQ-402. Added `OMP_SQUAD_REGRESSION_GATE` to README.md: paragraph under "Pre-land regression gate (opt-in)" + env-var table row. Final gate: 775 pass, 2 fail (RpcAgent detach and SquadManager-create-no-task — pre-existing timeouts, both fail identically on main).