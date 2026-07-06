# Epic 1 — Resident planner
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/plan-sync.ts, src/squad-manager.ts, src/features.ts, webapp/src/lib/planGraph.ts, src/intake.ts, src/planner.ts (new)
SUBPLAN: plans/meta-autonomous-fleet/epic-1-resident-planner/

## Goal

A standing loop that ingests a high-level objective and emits/maintains a living concern-DAG under `plans/<name>/`, re-planning as reality shifts — the autonomous complement to the human `/plan` skill. Closed concerns collapse; new blockers spawn child concerns; drift in verified state re-prioritizes the frontier.

## Approach

Today planning is 100% human-triggered. The only resident plan-touching code is `src/plan-sync.ts` (`syncPlanStatuses`, wired as a 300s timer in `SquadManager.start()`), and it reconciles STATUS **downward only** (open→closed) — it never creates or re-decomposes plans. Every autonomous caller (scout, opportunity, observer, plane-curator) files **flat Plane issues**, never `plans/<name>/NN.md` trees.

Build a new resident planner as a sibling loop constructed in `SquadManager.start()` (same shape as `Opportunity`), the **inverse of plan-sync**: it reads `listPlanDirs()`/`parsePlanConcerns()` (`src/features.ts`) plus the Plane backlog, diffs against the objective's verified state, and writes/updates plan-doc directories. It reuses `buildPlanGraph()` (`webapp/src/lib/planGraph.ts`) to validate the DAG it emits (cycle + unresolved-ref detection already exist) and `routeIntake()` (`src/intake.ts`) for per-concern process choice. Gate behind `OMP_SQUAD_RESIDENT_PLANNER`.

## Decomposition seed (candidate leaves for the sub-plan)

- New `src/planner.ts` module: pure `decompose(objective, verifiedState, existingConcerns) → ConcernDraft[]` with a schema; unit-tested against a fixture objective.
- Plan-doc writer: `ConcernDraft[] → plans/<name>/NN.md` files, idempotent (re-run updates in place, never duplicates), reusing the `features.ts` frontmatter conventions.
- DAG validation gate: run `buildPlanGraph` on emitted concerns, refuse to write on cycle/unresolved-ref, log the `PlanGraphIssue[]`.
- Resident loop wiring in `SquadManager.start()` behind the flag, interval + WIP-aware, one objective at a time.
- Re-plan trigger: consume the verified-state signal (Epic 3/7) so re-decomposition diffs against *verified* completion, not STATUS.

## Verify

With the flag on, hand the loop a fixture objective; confirm it writes a valid `plans/<name>/` tree that `buildPlanGraph` accepts, that a second tick updates rather than duplicates, and that a concern marked verified-done collapses out of the frontier on the next tick.
