# Feature proof/provenance contract
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/features.ts, webapp/src/lib/dto.ts, webapp/src/types.ts, webapp/src/lib/task-model.ts, webapp/src/lib/task-model.test.ts, tests/features.test.ts

## Goal

Preserve feature source, worktree, land readiness, and proof summary data from the daemon through the React task model so UI code can render proof/provenance without re-querying or parsing text.

## Approach

- Mirror backend `FeatureWorktreeStatus`, `WorktreeProofSummary`, and `LandReadiness` in `webapp/src/lib/dto.ts`.
- Add a task-level structure in `webapp/src/types.ts` for provenance and candidates. Keep it compact: source type/path, worktrees, proof aggregate, and blocker tags.
- Update `taskFromFeature` to carry:
  - canon source: plan dir, Plane issue identifiers, persisted/manual feature, or live agent
  - candidate branches/worktrees from `feature.worktrees`
  - proof aggregate: fresh/failed/stale/none counts and most recent proof time
  - land readiness aggregate: diverged, uncommitted, ahead, clean, no-branch
- Keep existing task fields stable so the starter UI does not break.
- Add tests for task mapping with fresh, stale, failed, and missing proof states.

## Acceptance Criteria

- A plan-backed feature carries its source of truth, linked Plane issues, candidate agents/worktrees, proof summary, and land readiness as structured fields from daemon to webapp.
- A derived plan can be adopted into a durable feature without changing its visible identity or losing plan context.
- Manually edited title, description, criteria, decisions, and relationships remain durable after the feature contract adds proof/provenance fields.
- Existing task lists and status lanes keep their current behavior for manual features, plan-derived features, Plane-backed features, and live agent features.

## Cross-Repo Side Effects

None. This stays inside `omp-squad` and the webapp DTO mirror.

## Verify

- `bun test tests/features.test.ts`
- `cd webapp && bun test src/lib/task-model.test.ts`
- `bun run check`
- `cd webapp && bun run typecheck`
