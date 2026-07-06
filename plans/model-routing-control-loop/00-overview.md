# Model-routing control loop

Staged observe → learn → act loop for omp-squad model selection. From `/research` of Devin Fusion (`plans/research-devin-fusion/BRIEF.md`), reshaped by adversarial design (`DESIGN.md`).

## Outcome
- A `task-class × model` outcome matrix (merge-rate, median-cost + coverage, median-confidence, in-run rework), surfaced in the webapp — the maintainer's long-open "task-class × model rubric scoreboard", shipped **honestly labeled as observational**.
- Once its three integrity fixes land, the same data drives **up-front model routing at dispatch** via the existing `shiftedModel` — cheap by default, bigger model where that class historically fails — gated and shadow-first.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| C01 Effective-model capture | Model axis is empty on the fleet path (dispatch sets no model) | mechanical | `src/receipts.ts`, `src/types.ts` |
| C02 Create-anchored denominator | Receipts omit units that die before finalize → inflated merge-rate | architectural | `src/squad-manager.ts`, `src/model-outcomes.ts`, new `isLandingUnit` |
| C03 Joined outcome row + idempotent key | One trustworthy row per unit joining routing + outcome | architectural | `src/squad-manager.ts` (`land()`, reconciler), new `src/task-outcomes.ts` |
| C04 Independent difficulty signal | De-confound: grade the router by something it didn't choose | mechanical | `src/receipts.ts`, `src/workflow/engine.ts`, the C03 row |
| C05 Matrix + honest surface | Make the scoreboard visible, labeled non-causal | mechanical | new `buildTaskClassMatrix`, `src/server.ts`, `webapp/src/lib/insights.ts` |
| C06 Route at dispatch via `shiftedModel` | The action arm — turn evidence into cheaper routing | architectural | `src/smart-spawn.ts`, `src/squad-manager.ts` dispatch path |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | C01, C02 | Independent data-capture fixes; disjoint files (mostly); both feed C03 |
| 2 | C03 | Joins C01's model + C02's roster/denominator into the outcome row |
| 3 | C04 | Adds difficulty fields onto C03's row |
| 4 | C05 | Aggregates + surfaces the completed row |
| 5 | C06 | Consumes the trustworthy matrix to route at dispatch |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| C01 | — | `grep -n "onAssistantUsage" src/receipts.ts` shows the usage hook exists |
| C02 | — | `grep -n "await this.persist()" src/squad-manager.ts` near createWithId (~:3184) |
| C03 | C01, C02 | C01 field on RunReceipt + C02 `isLandingUnit` both present |
| C04 | C03 | `task-outcomes.ts` row type exists |
| C05 | C04 | outcome rows carry model + difficulty + outcome |
| C06 | C05 | `buildTaskClassMatrix` returns populated cells for ≥1 real model |

## Deferred (separate future plan)
- **D1 Epsilon-random exploration** at dispatch — hard prerequisite before the loop may *regenerate* model policy from its own evidence (avoids self-confirming drift). Blocked by C06.
- **D2 Mid-run difficulty escalation** — Fusion's headline. Prereqs, all required: a real `getModel()` on the driver seam; predicate on the engine visit counter (`shared.visits`, `engine.ts:100`) not `resolveStyle`/`__reflectAttempt`; terminal-model + `escalated`-tag attribution so it can't poison C05; and `RpcAgent`-path coverage. Blocked by C06 + those four.

## Progress
- **Batch 1 SHIPPED** (2026-07-06): C01 + C02 closed, opus-reviewed, one review-fix applied (denominator must count errored/blocked units — keyed off static `autonomyMode`, not `effectiveMode`). Full suite 1554/1554, tsc clean. On PR #71.
- **Batch 2 SHIPPED** (2026-07-06): C03 closed, opus-reviewed, one review-fix applied (`resolveAgentIdForBranch` must pick most-recent by run time, not `readdir` order, or a reused branch misattributes a reconciled outcome). Full suite 1561/1561, tsc clean. On PR #71. Remaining: C04 → C05 → C06.
- Follow-up surfaced by C01 (not blocking): `squad-manager.ts` has a duplicated inline frame switch that shadows `receipts.ts`'s `ingest()`; de-dup so future frame-field additions can't drift silently.

## Notes
- Proceeded over an existing WIP pile (headless run): scanner reported 25 plans-with-open-concerns, but that count is inflated by the same plans duplicated across 6 worktree checkouts under `.claude/worktrees/`; oldest genuine is `meta-plan-autonomous-fleet` (2026-07-05).
- Build-vs-buy: **borrow every pattern, no dependency** — all seams pre-exist.
- Requires daemon restart to take effect. Every concern is env-gated or additive; nothing changes default routing until C06 is enabled (`OMP_SQUAD_MODEL_OUTCOMES=1`).
