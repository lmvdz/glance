# Epic 6 — Learning orchestrator (sub-plan)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
PARENT: plans/meta-autonomous-fleet/06-learning-orchestrator.md

## Outcome

The fleet learns from its own exhaust and gets measurably better over time. Two layers:

1. **Execute the designed-but-unbuilt `agentic-learning-loop`** (5 concerns, all still open) in its
   own batched order — reflexion between fixups, reward-boost on digests, retrieval provenance +
   in-builder fencing, recurring-failure memory, all behind `OMP_SQUAD_*` flags with a measured
   baseline. These are **pass-through leaves**: re-checked for freshness here, executed from their
   canonical files, NOT rewritten.
2. **Add outcome-driven model assignment on top** — a new per-`(model, complexity-tier)` land-outcome
   ledger, plus a boost-only, floored default-shift in the (dormant) `planSpawn` model-heuristic seam.
   Confidence-threshold tuning is scoped but blocked on Epic 5's confidence field, so it is filed as a
   branch (needs a deeper sub-plan once Epic 5 ships).

Respect the substrate's cuts: capability-match routing stays cut; reward stays boost-only ("absence =
unknown, never penalize"); deterministic proof stays the sole land gate. The new model-assignment
layer is the explicit reconciliation of "data-driven model choice" with that cut — it shifts *defaults*
from *outcome statistics*, never gates a land and never routes a cold model below its floor.

## Work

| # | Concern | New? | Complexity | Touches |
|---|---|---|---|---|
| 01 | Learning-loop metrics + flag scaffolding | pass-through | architectural | `src/metrics.ts` (new), `src/workflow/engine.ts`, `src/observer.ts`, `src/proof.ts`, `src/server.ts`, tests |
| 02 | Retrieval provenance + fence-in-builder | pass-through | architectural | `src/fabric-search.ts`, `src/fabric.ts`, `src/digest.ts`, tests |
| 03 | Reward-boost on digests | pass-through | architectural | `src/digest.ts`, `src/fabric.ts`, `src/proof.ts`, tests |
| 04 | Reflexion between fixups | pass-through | architectural | `src/reflection.ts` (new), `src/workflow/verify-workflow.ts`, `src/orchestrator.ts`, `src/fabric.ts`, tests |
| 05 | Recurring-failure memory | pass-through | architectural | `src/fabric.ts`, `src/fabric-search.ts`, `src/observer.ts`, `src/reflection.ts`, tests |
| 06 | Model-outcome ledger + reader | NEW leaf | architectural | `src/model-outcomes.ts` (new), `src/squad-manager.ts`, `tests/model-outcomes.test.ts` |
| 07 | Outcome-driven model default (boost-only, floored) | NEW leaf | architectural | `src/smart-spawn.ts`, `src/model-outcomes.ts`, `tests/smart-spawn.test.ts` |
| 08 | Confidence-threshold tuner | NEW **branch** (needs deeper) | architectural | `src/autonomy.ts`, `src/metrics.ts`, `src/model-outcomes.ts` |

Pass-through leaves 01–05 live in their canonical files under `plans/agentic-learning-loop/`; execute
them there. Freshness corrections (line drift since they were written) are in `DESIGN.md` — apply them
when you open each concern.

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Foundational + independent; establishes metrics + the `OMP_SQUAD_*` flag pattern 03/04/05/06/07 all reuse. |
| 2 | 02 | `KbDoc` timestamp threading + fence-inside-builder; every later fabric change builds on it. |
| 3 | 03 | Reward as a `KbDoc.weight` contribution — needs 02's clean weight/threading. |
| 4 | 04 | Reflection store + injection; reuses 02's fence + per-worktree store pattern. |
| 5 | 05 | Reuses 04's `reflect()` for root-cause and 01's observer streak instrumentation. |
| 6 | 06 | Model-outcome ledger. Independent of the fabric chain; only needs 01's flag helper for the metric tag. Can run in parallel with batches 2–5. |
| 7 | 07 | Consumes 06's `modelOutcomes()` reader. |
| 8 | 08 | Blocked on Epic 5 (confidence field). Decompose into leaves once Epic 5 has shipped. |

Batches 1–5 are the `agentic-learning-loop`'s own sequence (they contend on `src/fabric.ts`, so they
stay sequential — see that plan's Shared-File Analysis). Batch 6 (concern 06) touches only
`src/squad-manager.ts`'s land site + a new file, so it runs in parallel with 2–5; it needs only
concern 01's flag helper to tag its metric.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | `test -f src/metrics.ts` returns false (still to be created) |
| 02 | — | `grep -n "Caller is responsible for fencing" src/fabric-search.ts` still hits line 188 (fence not yet internal) |
| 03 | 02 | `grep -n "ranAt\|source" src/fabric-search.ts` shows provenance fields on `FabricSearchResult` |
| 04 | 02 | fence lives inside `buildContextPrimer`; `test -f src/reflection.ts` returns false |
| 05 | 04, 01 | `src/reflection.ts` exports a reusable root-cause fn; observer streak count is instrumented (01) |
| 06 | 01 | `grep -n "recordLandOutcome" src/squad-manager.ts` hits the land site (~2190) where the new record call is appended; `learningFlags`/flag helper from 01 exists |
| 07 | 06 | `grep -n "export function modelOutcomes" src/model-outcomes.ts` returns the reader |
| 08 | Epic 5 | `grep -n "confidence" src/autonomy.ts` returns a confidence field on the run/policy input (Epic 5 leaf shipped) — currently NOTHING, so 08 stays a branch |

## Notes

- Deterministic proof (`proofGate`) remains the ONLY land gate. Nothing here weakens it. The
  model-outcome ledger only *reads* land results as a statistic; the default-shift only biases a
  spawn-time model *suggestion*.
- Concern 08 is deliberately NOT a leaf: the confidence signal it tunes against is authored by Epic 5
  and does not exist yet. Filed as a branch with a leaf-shaped stub; decompose after Epic 5 ships.
- File the leaf concerns to Plane via `/plan-to-plane` after this decomposition, so `/sync-plans`
  tracks the executable units (06/07 now; 08 after Epic 5).
