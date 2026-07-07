# Decision Capture

## Outcome
An agent can call `squad_record_decision` to record a consequential choice, which lands on its feature (`source:"agent"` + `{agentId,runId}` provenance) and immediately shows up in the cold-start primer, `squad_kb_search`, the KnowledgePanel "Decisions on record" list, and the feature's decisions log. This fills the currently-empty institutional-memory channel with high-signal, provenance-carrying entries — the prerequisite the earlier (descoped) consolidation work was missing.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 — `squad_record_decision` host tool + provenance | The zero-cost, high-signal capture mechanism: a non-blocking reserved host tool writing `source:"agent"` decisions with a real backlink | architectural | `src/squad-manager.ts`, `src/types.ts`, `src/fabric.ts`, `src/fabric-search.ts`, `src/metrics.ts` |
| 02 — Surfacing: agent-source badge + guidance | Make agent-captured decisions legible (a `source:"agent"` badge) and nudge agents to actually use the tool | mechanical | `webapp/src/components/KnowledgePanel.tsx`, `webapp/src/components/TaskDetail.tsx`, `webapp/src/lib/dto.ts`, tool description in `src/squad-manager.ts` |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Backend capture path — the write must exist before anything surfaces it |
| 2 | 02 | UI/guidance layer over 01's data + provenance field |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `grep -n "sourceRef" src/types.ts` returns the new field; `grep -n "squad_record_decision" src/squad-manager.ts` returns the tool |

## Status
**Both concerns CLOSED (2/2) — shipped on PR #90.** Backend 1677 pass / webapp 574 pass, both tsc clean. Feature is flag-gated `OMP_SQUAD_DECISION_CAPTURE` (default off). Not yet live-driven with a real model agent autonomously calling the tool (needs daemon + tokens); the handler path is exercised end-to-end through a real `SquadManager`.

## Notes
- **Proceeded over a large WIP pile** (Phase 0 scan: 79 plans with open concerns, oldest `meta-plan-autonomous-fleet` 2026-07-05) — this run is a research→plan chain, so the debt is logged here rather than blocking the pipeline.
- This plan is the **pivot** from the descoped consolidation design (see `DESIGN.md`). The consolidation/de-pollution work stays cut until captured-decision volume makes it measurable.
- Passive run-end LLM harvest of decisions is **deliberately not built** — `finalizeRun` fires every turn, so it would be fleet-multiplied cost + extraction noise. Revisit only as an opt-in end-of-run extraction if explicit capture proves too sparse.
- Flag `OMP_SQUAD_DECISION_CAPTURE` (default off) gates tool registration + dispatch, matching the `learningFlags()` discipline.
