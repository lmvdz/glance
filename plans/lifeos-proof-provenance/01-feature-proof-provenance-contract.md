# Feature proof/provenance contract
STATUS: open
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

- The web task model preserves each feature's canon source, candidate worktrees, land readiness, and proof summary.
- The task detail UI can render proof/provenance from structured fields without parsing markdown descriptions.
- Existing task lists, status labels, and manually edited criteria continue to behave as before.

## Cross-Repo Side Effects

None. This stays inside `omp-squad` and the webapp DTO mirror.

## Verify

- `bun test tests/features.test.ts`
- `cd webapp && bun test src/lib/task-model.test.ts`
- `bun run check`
- `cd webapp && bun run typecheck`
