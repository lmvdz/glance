# Give the FLEET outcome-driven, cost-aware model selection (the prize)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/intake (routeIntake), src/smart-spawn.ts (shared scorer)

## Goal
Make the AUTONOMOUS fleet — not just the interactive spawn box — choose each unit's model from the measured ledger. This is the actual "turn attribution into routing decisions" the research was after; concerns 03/04 only touch the human path.

## Evidence the fleet has no model routing
`create({autoRoute:true})` → `routeIntake(opts.task, opts.repo, this.llmClassify)` at `squad-manager.ts:3166` sets **workflow / verify / verifyMode / thinking / executionRole** — NOT `model`. The fleet then spawns with `opts.model` as-passed (usually undefined → omp's own default). `shadowCostCheck` at :3181 is the only cost-aware touch and is WARN-only. `planSpawn`/`shiftedModel` is never on this path. Verified: no `model-route.ts`, no `routeModelForTaskClass` exists (a red-team claim that it did was fabricated and rejected).

## Approach
- Extract the model-selection logic from `shiftedModel`/concern-04's scorer into a shared, pure `pickModel({ tier, taskClass?, scoreboard, explicit })` so BOTH the interactive path (concern 03) and the fleet path use one implementation — no second router that can drift.
- Wire it into the `create(autoRoute)` path: after `routeIntake` resolves `thinking` (which feeds `tierOf`), and only when `opts.model` is unset (never override an explicit choice), call `pickModel` with the manager's scoreboard (`buildScoreboard(readAllReceipts(this.stateDir), readModelOutcomes(this.stateDir))`, the cost-gate.ts:45 pattern) and stamp `opts.model`.
- Keep it flag-gated on the SAME `OMP_SQUAD_MODEL_OUTCOMES=1` and shadow-first (log the pick without applying) behind an `OMP_SQUAD_MODEL_ROUTE_SHADOW`-style flag, so it can be observed against real dispatches before it steers spend. Mirror `shadowCostCheck`'s shadow discipline.
- Respect provider/harness compatibility (concern 02's guard): the picked family must be runnable on the unit's resolved harness/subscription.

## Cross-Repo Side Effects
Shares `smart-spawn.ts` (the extracted scorer) with 03/04 and `squad-manager.ts` with 01 — sequence after them. Changes what model the fleet actually spends on — ship shadow-first.

## Verify
- Unit test `pickModel` in isolation (same cases as concern 04).
- Integration: with a seeded non-empty ledger + flag on + shadow off, drive a `create({autoRoute:true})` (fake/omitted omp binary is fine — assert on the resolved `opts.model` before spawn) and assert the fleet unit is stamped with the ledger-preferred family for its tier.
- Shadow mode: assert the pick is logged but `opts.model` is left unset.
- BLOCKED until concern 01 proves a non-empty ledger on a live land — routing on empty data is the no-op this whole plan exists to avoid.
