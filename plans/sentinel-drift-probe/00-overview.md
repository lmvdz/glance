# Sentinel v0 — wrong-direction drift probe

## Outcome
When enabled (`OMP_SQUAD_SENTINEL=1`), the daemon reads each eligible working agent's mid-run reasoning, flags when the work is trending away from the unit's declared acceptance criteria, confirms the flag with the existing independent judge against the working-tree diff, and appends the result to a durable off-Plane audit log. No agent is contacted, no gate is affected, nothing is surfaced yet. The deliverable is the **measurement substrate**: a judge-confirmed-precision number that decides whether the deferred surface/steer machinery is ever built.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 Drift probe core | The action-free monitor + the durable judge-confirmed record — all headless-testable, no edits to existing files | architectural | `src/drift-lens.ts` (new), `src/drift-audit.ts` (new) |
| 02 Fold into Scout + wire the sink | Invoke the lens on Scout's existing reasoning slice; eligibility gate; manager wires the action-free sink → confirm + audit; default OFF | architectural | `src/scout.ts`, `src/squad-manager.ts` |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | New files only, zero shared-file risk; defines the `Hypothesis` type + `confirm()` that 02 wires. |
| 2 | 02 | Integration; imports 01. Touches the two existing files. |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `test -f src/drift-lens.ts && grep -q "export.*Hypothesis" src/drift-lens.ts` |

## Notes
- **WIP snapshot at plan time** (proceeded per the research→plan pipeline): 90 plans, 36 with open concerns, 146 open (oldest `meta-plan-autonomous-fleet` 2026-07-05). Debt logged, not hidden; the forcing function fires at the next interactive `/plan` or `/wip`.
- Scope was cut from a six-kind epic to this single probe by an adversarial design pass (DESIGN.md). The deterministic landing-readiness lints (scope-creep, proof-state-at-landing) are a **separate sibling plan**, not decomposed here.
- Standing invariant across both concerns: **drift never feeds `src/confidence.ts`** (mid-run drift is not a linear predictor of the landed state); the committed diff is the only thing ever scored into trust.
- The interpretability separation contract (monitor ≠ judge ≠ intervenor) is the reason the lens module imports no validator/steer/manager path — preserve it in code review.
