# Epic 6 — Learning orchestrator
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: plans/agentic-learning-loop/*, src/metrics.ts (new), src/reflection.ts (new), src/land-ledger.ts, src/proof.ts, src/fabric.ts, src/intake.ts, src/workflow/stylesheet.ts, src/squad-manager.ts
SUBPLAN: plans/meta-autonomous-fleet/epic-6-learning-orchestrator/

## Goal

The fleet learns from its own exhaust and gets measurably better over time: it executes the designed-but-unbuilt `agentic-learning-loop`, then adds **outcome-driven** model assignment and confidence-threshold tuning on top.

## Approach

The learning substrate is fully designed and entirely unbuilt: `plans/agentic-learning-loop/` (5 open concerns; `src/metrics.ts` and `src/reflection.ts` confirmed not to exist). Execute it in its own designed order — 01 metrics + flag scaffolding (load-bearing baseline), 02 retrieval provenance, 03 reward-boost on digests, 04 Reflexion between fixups (`orchestrator.ts` fixup boundary), 05 recurring-failure memory keyed on the Observer's failure-fingerprint streak. **Respect its cuts**: capability-match model routing was explicitly cut as a category error; reward stays boost-only ("absence = unknown, never penalize"); deterministic proof stays the sole land gate.

On top of that substrate, add two continuous-improvement loops as siblings in `SquadManager.start()` (beside Scout/Opportunity):

- **Outcome-driven model assignment.** Model choice today is static/heuristic across `intake.ts` (process), `smart-spawn.ts` (hardcoded "opus for hard"), and `workflow/stylesheet.ts` (CSS per-node). Read landed-vs-rejected outcomes per `model × complexity tier` from `land-ledger.ts` and shift the *defaults* — boost-only, never a gate, framed as outcome statistics not capability matching (this is the reconciliation with the learning-loop cut).
- **Threshold tuning.** Consume Epic 5's confidence + landed-vs-rejected to refine the propose-only threshold and decomposition granularity over time.

## Decomposition seed (candidate leaves for the sub-plan)

- Execute `agentic-learning-loop` concerns 01–05 (each already a near-leaf; may pass through directly as leaves after a freshness re-check of line numbers).
- New outcome-stats reader over `land-ledger.ts`: `modelOutcomes(model, complexity) → {landed, rejected}`; unit-tested.
- Outcome-driven default shift in the model-assignment seam (boost-only, floored so a cold model is never starved).
- Confidence-threshold tuner consuming Epic 5's signal; bounded step size.
- A/B measurability: every behavior behind an `OMP_SQUAD_*` flag with a baseline metric (reuse concern 01's scaffolding).

## Verify

Run the fleet with the loop on against a baseline run with it off; confirm (a) reflexion injects a root-cause note into a retried fixup, (b) a first-try-green success ranks higher in the next agent's primer, and (c) the model-assignment defaults shift toward the model with the better landed-rate for a complexity tier — without ever penalizing a cold model below its floor or overriding the deterministic land gate.
