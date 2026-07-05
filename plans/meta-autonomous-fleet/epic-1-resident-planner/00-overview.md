# Epic 1 — Resident planner (sub-plan)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural

## Outcome

A standing daemon loop (`OMP_SQUAD_RESIDENT_PLANNER`, default OFF) that ingests an
`plans/<name>/OBJECTIVE.md` and maintains a living, valid concern-DAG under that
dir — the inverse of `plan-sync.ts`. It decomposes the objective against verified
state (`hasProof` DoneProof ledger), writes idempotent `NN-slug.md` concern docs +
a `## Dependency graph` overview table, gates every emission through the existing
`validatePlanConcerns` (cycle/dangling refusal), re-plans only when verified state
changes, and never rewrites a terminal STATUS. Verified-done concerns collapse out
of the frontier on the next tick.

## Work

| # | Concern | Complexity | Touches |
|---|---|---|---|
| 01 | Planner core — schema, prompt, parser, frontier diff (pure) | architectural | `src/planner.ts` (new), `src/planner.test.ts` (new) |
| 02 | Plan-doc writer + DAG validation gate (idempotent) | architectural | `src/plan-writer.ts` (new), `src/plan-writer.test.ts` (new) |
| 03 | ResidentPlanner loop class (Opportunity-shaped) | architectural | `src/resident-planner.ts` (new), `src/resident-planner.test.ts` (new) |
| 04 | Wire the loop into `SquadManager.start()`/`stop()` behind the flag | mechanical | `src/squad-manager.ts` |
| 05 | `omp-squad plan-decompose <dir>` one-shot CLI + end-to-end verify | mechanical | `src/index.ts` |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| A | 01 | Pure core; everything imports `ConcernDraft` and the prompt/parser from here. |
| B | 02 | Needs 01's `ConcernDraft`; emits docs `validatePlanConcerns` can read back. |
| C | 03 | Needs 01 (decompose) + 02 (writer); injects `hasProof` as the verified oracle. |
| D | 04, 05 | Both consume the built loop/one-shot; independent of each other. |

## Dependency graph

| Concern | BLOCKED_BY | 30s check |
|---|---|---|
| 01 | none | `grep -n "decideTyped" src/omp-call.ts` (LLM decode primitive exists) |
| 02 | 01 | `grep -n "validatePlanConcerns" src/features.ts` (the gate already exists, reuse it) |
| 03 | 01, 02 | `grep -n "class Opportunity" src/opportunity.ts` (loop template exists) |
| 04 | 03 | `sed -n '739,757p;918p;922p' src/squad-manager.ts` (plan-sync/Opportunity wiring + teardown seams) |
| 05 | 03 | `grep -n "cmdPlanValidate" src/index.ts` (CLI command template exists) |

## Notes

- Every leaf is Sonnet-ready: concrete files, a `bun test` acceptance test with an
  injected/stubbed LLM (hermetic), and an explicit scope boundary. Leaf 05's
  acceptance test additionally exercises the real `omp` path end-to-end.
- The DAG gate is **reuse, not build**: `validatePlanConcerns` (features.ts:410)
  already wraps `buildPlanGraph`. Leaf 02 calls it; it does not re-implement cycle
  detection.
- Not filed to Plane yet — run `/plan-to-plane` on these five leaves after review so
  `/sync-plans` tracks the executable units.
