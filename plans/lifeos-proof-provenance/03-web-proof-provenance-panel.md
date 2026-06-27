# Web proof/provenance panel
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/TaskDetail.tsx, webapp/src/components/TaskProperties.tsx, webapp/src/components/ProofProvenancePanel.tsx, webapp/src/components/ProofProvenancePanel.test.tsx, webapp/src/components/TaskDetail.test.tsx

## Goal

Make proof and provenance visible in the feature/task detail view without making operators open raw traces or infer readiness from tags.

## Approach

- Add a focused `ProofProvenancePanel` component instead of growing `TaskDetail.tsx` inline.
- Render:
  - canon/source row: plan path, issue identifiers, persisted/manual feature, or live agent
  - candidate row(s): branch/worktree/agent name, changed files, ahead/behind, readiness
  - proof row: fresh/stale/failed/none, ran-at timestamp, artifact count
  - readiness row: current blocker and next action
  - latest run evidence when present: cost/tokens/duration/tool count from existing receipt rollups
- Put the compact summary in `TaskProperties.tsx`; detailed candidate/proof rows can live in the main detail pane or an expandable panel.
- Add buttons only for commands already supported by APIs: verify feature, land feature, open trace/diff. Disable buttons when readiness explains they cannot run.
- Keep raw proof output hidden by default.

## Acceptance Criteria

- Operators can see the feature's source of truth, linked Plane tickets, candidate branches, and plan revision candidates in one place.
- Operators can tell at a glance whether proof is fresh, stale, failed, or absent, and what blocks landing.
- Operators can start implementation from a plan-backed feature without leaving the detail view.
- Operators can create a Plane module, or create a Plane module plus concern tickets, from the plan detail view.
- Raw command output stays hidden by default; evidence links and concise readiness summaries are visible.

## Cross-Repo Side Effects

None.

## Verify

- `cd webapp && bun test src/components/ProofProvenancePanel.test.tsx src/components/TaskDetail.test.tsx`
- `cd webapp && bun run typecheck`
