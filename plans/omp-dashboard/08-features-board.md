# Features board + feature detail
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/features/*

## Goal
The board view: feature stage lanes (planned → issues-created → in-progress → review → landed/done)
and a feature detail (member agents, per-worktree land readiness, plan concerns, Plane tickets).

## Approach
- **Board** — lanes by `FeatureStage`; cards from `FeatureDTO` showing agent count, `unlandedFiles`,
  `blocked`, `divergent`, `workflowStage`/`workflowProgress`. Reuse the `features` from `useSquad`
  (and `buildGraphModel` grouping where useful). Skip identical repaints (mirror `index.html`'s sig).
- **Detail** — members (`agentIds`), worktree status (`FeatureWorktreeStatus`: ahead/behind/readiness/
  proof), plan pipeline (`GET /api/features/:id/pipeline`), tickets (`GET /api/features/:id/tickets`),
  actions: verify (`/verify`), land (`/land`), group-in-Plane (`/module`), implement-concern (`/agents`).

## Cross-Repo Side Effects
None. Uses `lib/api.ts` (concern 05).

## Verify
- Features render in the right lanes; counts/badges match the roster.
- Detail shows members + per-branch land readiness; verify/land actions fire and toast.

## Resolution
FeatureBoard (stage lanes) + motion slide-over feature detail; DetailPanel gained Verify/Land actions. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0; `cd webapp && bun run build` + `bun run test` 14/0; runtime smoke OK).
