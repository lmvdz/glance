# Design: LifeOS-style proof and provenance for omp-squad

## Approach

Borrow the useful LifeOS invariants without building a new knowledge system: make every feature in the dashboard show where its truth comes from, what candidate work exists, whether that work has a fresh proof, and what blocks promotion to canon/main.

The existing system already has most of the substrate. `plans/` act as markdown canon for planned work, `FeatureDTO.worktrees` already computes live land/proof status, `/api/features/:id/pipeline` returns the selected feature plus plan docs/issues/comments, `/api/agents/:id/receipts` and `/api/trace/:id` expose run evidence, and land already refuses stale or failed proof. The gap is that the web task model drops the proof/worktree fields, the detail pane does not explain promotion readiness, and agent-written plan changes are not represented as low-trust candidates before they become source-of-truth plan edits.

This plan ships the first slice: a feature-level proof/provenance panel and a small canon-candidate workflow for plan edits. It does not introduce vector search, a GBrain clone, or autonomous self-improvement scoring.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Canon | Treat `plans/<name>/` markdown plus persisted feature fields as canon | New database-backed knowledge store | The repo already derives features, criteria, decisions, prerequisites, and plan documents from markdown. Keep the source visible and editable. |
| Candidate work | Model worktrees, annotations, and agent plan revisions as candidates with provenance | Collapse everything into task description text | Operators need to know what is proposed, who/what produced it, and why it is or is not promotable. |
| Proof source | Reuse `FeatureDTO.worktrees[].proof` and `runProof` output | Add a parallel proof service | Proof gating exists and is keyed to HEAD; the first UI slice should expose it rather than duplicate it. |
| Promotion readiness | Compute a small read model from existing fields: source, candidates, proof, land readiness, missing acceptance | Ask the agent to summarize readiness | Readiness is control-plane state, not prose. Agents may explain it, but the UI should compute the blockers. |
| Receipts | Show latest run evidence opportunistically via existing receipt/trace APIs | Build aggregate analytics first | Receipts are useful context, but proof/provenance should work even before rich analytics is complete. |
| Plan edits | Add candidate status for agent-written plan changes before canon adoption | Let planner agents directly mutate plans with no distinct review state | This matches LifeOS's low-trust candidate → review gate → canon pattern and the repo's existing annotation flow. |
| Scope | Feature detail panel first; no global graph yet | Build a full project graph | A graph is appealing, but the immediate operator pain is "can this land and why do I trust it?" |

## Risks

| Risk | Resolution |
|---|---|
| The web DTO currently omits backend `worktrees`, so UI work may silently lack proof state | Start with schema/mapping tests that fail until `FeatureDTO` and `Task` preserve proof summaries. |
| Proof detail may include noisy command output | Show command/result state and artifact count by default; keep raw tail behind an expandable block or trace link. |
| Agent plan candidates could become another WIP pile | Candidate rows must have explicit states: candidate, accepted, rejected, superseded; rejected/superseded candidates stay visible but do not block canon. |
| `/api/features/:id/pipeline` may become a grab bag | Keep the pipeline payload source-oriented: feature, concerns, documents, issues, comments, candidate revisions, agent ids. Avoid embedding rendered UI decisions in the API. |
| Multiple concerns touch shared DTO/task files | Backend contract concern owns `src/types.ts` and `webapp/src/lib/dto.ts`; UI concerns only consume the new shape. |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| "LifeOS-inspired" can sprawl into a second product | critical | This design limits the first slice to proof/provenance cards and canon promotion candidates. No new retrieval engine or ambient ingestion. |
| The dashboard could imply proof exists when only screenshots exist | critical | Preserve current rule: deterministic command gates; vision artifacts are evidence-only. UI labels artifacts separately. |
| Candidate plan edits may conflict with source files being implemented | significant | Candidate provenance includes producing agent/run and touched plan path; accepting a candidate refreshes feature context before more implementation is spawned. |
| Showing receipts as proof would weaken the land gate | significant | Receipts are run evidence only. Proof state comes from `Proof.ok` and matching HEAD commit. |
| Extra cards could clutter the already dense task detail pane | minor | Put proof/provenance in the right properties rail and use compact status rows; detailed trace opens on demand. |

## Open Questions

None blocking. During implementation, decide whether the first candidate store is persisted in the existing feature record or as comment-like artifacts. Prefer the existing comments/artifacts path if it can express state without broad schema churn.
