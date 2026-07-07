# Cost projection gate (shadow-only)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: src/cost-gate.ts, src/squad-manager.ts, src/land.ts

## Goal
Project a unit's expected spend before dispatch/land and WARN (shadow) when it would exceed a budget. Enforce-mode deferred.

## Approach
- New `src/cost-gate.ts`: `projectCost(stateDir, model, tier): {costPerLandedChange?, landRate?, sample} | undefined` reusing `modelOutcomes(stateDir,model,tier)` (sync land-rate) + `buildScoreboard` (`costPerLandedChange`). `costGateMode()` = `OMP_SQUAD_COST_GATE` ∈ `off|shadow|enforce` (default off). Require `sample = landed+rejected ≥ OMP_SQUAD_COST_MIN_SAMPLE` before the gate may speak (thin history stays silent).
- Wire in `shadow` at the `create()` admission seam (squad-manager ~:3079, tier/model known post-routeIntake) and at `landBranch`: log `cost-gate(shadow): would <ASK|DENY> — projected $X over budget $Y` via the automation log. **enforce mode throws/parks only when explicitly set — deferred, not wired in v1.**

## Verify
`bun test src/cost-gate.test.ts`: below min-sample → silent; over-budget in shadow → logs, never blocks; off → no-op. No behavior change to dispatch/land in v1 (shadow logs only).
