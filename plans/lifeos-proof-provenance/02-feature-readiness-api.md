# Feature readiness API
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/features.ts, src/server.ts, src/squad-manager.ts, tests/features.test.ts, tests/control-tower-api.test.ts

## Goal

Expose a computed feature readiness read model that explains whether a feature can be promoted/landed, what blocks it, and what the operator should do next.

## Approach

- Add a pure helper near feature derivation that computes readiness from `FeatureDTO` and its worktrees:
  - `ready`: true only when all landable work has fresh proof and no diverged/uncommitted blockers
  - `state`: no-candidate, needs-proof, proof-failed, proof-stale, blocked-input, diverged, ready, landed/done
  - `blockers`: short machine-readable reasons
  - `nextAction`: one operator-facing action string
- Return this readiness from `/api/features/:id/pipeline` and, if cheap, inline on `FeatureDTO`.
- Keep the helper deterministic and model-free.
- Do not change `proofGate`; this API explains the gate but does not replace it.
- Add API tests using fake/persisted feature state and temp git worktrees where needed.

## Acceptance Criteria

- Each feature exposes a deterministic readiness state, blocker list, and next action.
- Readiness agrees with the existing land/proof gate and never weakens it.
- Features with stale, failed, missing, or fresh proof produce distinct operator-facing states.

## Cross-Repo Side Effects

None.

## Verify

- `bun test tests/features.test.ts`
- `bun test tests/control-tower-api.test.ts`
- `bun run check`
