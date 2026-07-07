# Attribution → routing (sirvir borrows), pivoted

## Outcome
The autonomous fleet picks each unit's model from **measured** land-rate and $/landed-change — not a static heuristic — and a single provider's usage cap stops freezing the **whole** fleet. Precondition: the outcome ledger that all of this reads is actually being written (today it is empirically empty).

## Why this plan looks different from the research brief
`/research` sold this as "70% built, reconnect one dead wire." The adversarial `/plan` design pass (Designer → 2 red teams → arbiter), **verified against live `~/.glance`**, proved that false: the outcome ledger has never been written, the router is wired only to the interactive human spawn box (the fleet's `autoRoute`/`routeIntake` never selects a model), and the drafted cost formula fails closed. See `DESIGN.md`. The real gap is upstream and larger — this plan chases it.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 recording unlock | The ledger is empirically empty — recording never fires. Nothing downstream is real until it does. | research | squad-manager.ts, model-outcomes.ts |
| 02 key coherence | Recorded key = `provider/id`; candidate labels = `"opus"/"default"` — they can't match, so the incumbent never exists. | architectural | model-outcomes.ts, smart-spawn.ts, attribution-scoreboard.ts |
| 03 dead-wire fix | `server.ts:1376` calls the router without the outcomes reader — the honest, cheap, interactive-only fix. | mechanical | server.ts, squad-manager.ts, smart-spawn.ts |
| 04 cost formula | The drafted blend fails closed (unbounded ratio vetoes escalation; null cost divides by zero). Make it bounded, null-safe, tie-breaker. | architectural | smart-spawn.ts, attribution-scoreboard.ts |
| 05 fleet routing (the prize) | The fleet has **no** outcome-driven model selection. Give `create(autoRoute)` one, fueled by 01+02. | architectural | squad-manager.ts, intake/router |
| 06 degradation ladder (GOAL 2) | One provider's cap freezes the whole fleet; per-lineage gating mis-partitions on the only verified harnesses. | architectural | rate-limit.ts, dispatch.ts, harness-registry.ts, model-lineage.ts |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 06 | 01 is the precondition for the GOAL-1 chain; 06 is an independent GOAL-2 track (disjoint files) — run in parallel. |
| 2 | 02 | Key coherence; touches the model-outcomes/scoreboard/smart-spawn trio the GOAL-1 chain shares — do it before the consumers. |
| 3 | 03, 04 | Both build on coherent keys (02). They share `smart-spawn.ts` → same agent / sequential, not parallel. |
| 4 | 05 | The prize — needs real data (01), coherent keys (02), and a correct formula (04). |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | `ls ~/.glance/model-outcomes.json` → absent today |
| 02 | — | `grep SHIFT_CANDIDATES src/smart-spawn.ts` → `["opus","default"]`; recorded keys are `provider/id` |
| 03 | 02 | keys must cohere or the reconnect still no-ops; `grep -n planSpawn src/server.ts` |
| 04 | 02 | `grep costPerLandedChange src/attribution-scoreboard.ts` → per-model, null when landed=0 |
| 05 | 01, 02, 04 | `ls ~/.glance/model-outcomes.json` non-empty AFTER 01; `grep routeIntake src/squad-manager.ts:3166` selects workflow/verify/thinking, not model |
| 06 | — | `grep -n 'deps.paused' src/dispatch.ts` → single global pre-check at ~:162 |

## Notes
- Proceeded over a large WIP pile (116 plans with open concerns; bulk are auto-generated `console-agent-tooling` sub-plans, always 6-open/0-closed) — a research→plan pipeline handoff, logged not blocked.
- **01 may be deep.** Two stacked root causes, either sufficient: (A) the running daemon binary predates the recording code (landed on main 2026-07-06); (B) the record branch is gated `!result.retryable`, and the dominant live failure mode is retryable dirty-main — so recording is starved even on current code. Concern 01 must resolve both, and (B) may fold into the broader "units never commit / dirty main" problem (OMPSQ-417..423). If 01 reveals landing itself is broken, STOP and reassess before 05 — routing on a fleet that can't land is premature.
- Everything downstream of 01 is honest-but-inert until 01 proves a non-empty ledger on a live land. Don't ship 03/04/05 as "outcome-driven routing" without that proof.
