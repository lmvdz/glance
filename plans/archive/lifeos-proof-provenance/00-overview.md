# LifeOS-style proof and provenance

STATUS: done
PRIORITY: p0
REPOS: omp-squad

> 2026-07-01 reconcile: the whole plan is on `main` — the formerly stranded branch landed via
> `970d296` + conflict fix `4daf014` (readiness API + `FeatureProofAggregate`, `ProofProvenancePanel`,
> `PlanRevisionCandidate` with `/plan-candidates` accept/reject/supersede endpoints, docs + tests).
> Every concern previously said `open`; code-verified done.

> WIP gate: scanner showed 5 existing plan dirs with 18 open concerns. Proceeded because the operator explicitly said `proceed`.

## Outcome

- Operators can open a feature/task and immediately see its canon source, candidate branches/plan edits, proof freshness, land blockers, latest run evidence, and the concrete next action.
- Agent-written plan changes are treated as reviewable candidates before they become canon.
- The dashboard reflects the existing proof gate instead of relying on agent summaries.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 Feature proof/provenance contract | Preserve backend proof/worktree/source data through the web DTO and task model | architectural | `src/types.ts`, `src/features.ts`, `webapp/src/lib/dto.ts`, `webapp/src/types.ts`, `webapp/src/lib/task-model.ts`, tests |
| 02 Feature readiness API and tests | Provide a small computed read model for blockers and next action | architectural | `src/server.ts`, `src/squad-manager.ts`, `src/features.ts`, `src/types.ts`, tests |
| 03 Web proof/provenance panel | Render compact proof, source, candidate, and receipt evidence in task detail | architectural | `webapp/src/components/TaskDetail.tsx`, `webapp/src/components/TaskProperties.tsx`, new focused components, tests |
| 04 Canon candidate plan revisions | Track agent-written plan edits as low-trust candidates with accept/reject/supersede states | architectural | `src/comments.ts`, `src/types.ts`, `src/server.ts`, `src/squad-manager.ts`, `webapp/src/components/TaskDetail.tsx`, tests |
| 05 Verification and docs | Lock the behavior down and document the operator workflow | mechanical | `README.md`, `webapp/README.md`, targeted tests |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Owns shared data shape; everything else consumes it. |
| 2 | 02 | Computes readiness from the contract before UI renders it. |
| 3 | 03 | Web can render real backend data after 01 and 02. |
| 4 | 04 | Candidate plan workflow builds on proven source/provenance surfaces. |
| 5 | 05 | Docs and verification after behavior stabilizes. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `webapp/src/lib/dto.ts` includes worktree proof fields mirrored from `src/types.ts`. |
| 03 | 01, 02 | A feature detail API response exposes proof/readiness without scraping text. |
| 04 | 01 | Candidate records can cite feature id, plan path, agent/run provenance, and state. |
| 05 | 01-04 | Targeted tests for contract, readiness, UI, and candidate transitions pass. |

## Shared-File Analysis

- `src/types.ts` and `webapp/src/lib/dto.ts` are owned by concern 01; later concerns only append fields if concern 01 missed a required shape.
- `src/features.ts` is touched by 01 and 02; concern 01 owns raw feature derivation, concern 02 owns computed readiness helpers.
- `src/server.ts` is touched by 02 and 04; implement sequentially because both add feature-scoped endpoints.
- `TaskDetail.tsx` is touched by 03 and 04; 03 should extract small proof/provenance components first so 04 can add candidate controls without editing the same large blocks.
- `TaskProperties.tsx` belongs to 03 for the compact rail presentation.

## Notes

- Deterministic proof remains the only land gate. Screenshots, traces, receipts, and agent summaries are evidence, not proof.
- This is a first slice of the LifeOS pattern: canon, candidate, proof, provenance, and review. Retrieval, prediction, oracles, and global graph views stay out of scope until this is useful.
