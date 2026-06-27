# Verification and docs
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: README.md, webapp/README.md, tests/features.test.ts, webapp/src/lib/task-model.test.ts, webapp/src/components/ProofProvenancePanel.test.tsx

## Goal

Document the new operator workflow and leave small runnable checks that fail if proof/provenance or canon-candidate behavior regresses.

## Approach

- Update `README.md` command-center docs to explain:
  - canon source
  - candidate work
  - proof freshness
  - promotion readiness
  - evidence vs proof
- Update `webapp/README.md` to describe the detail pane proof/provenance panel and candidate plan revision flow.
- Ensure tests cover:
  - backend feature proof summaries
  - web task mapping preserves proof/provenance
  - readiness blockers and next actions
  - candidate accept/reject/supersede transitions
  - proof/provenance panel rendering
- Run narrow tests first, then full typechecks.

## Acceptance Criteria

- The README explains proof, evidence, provenance, candidate work, Plane modules/tickets, and promotion readiness in operator language.
- The webapp README describes how to move from a plan to implementation, how to create a Plane module, and how concern tickets are generated.
- Regression tests fail if verify commands reappear as acceptance criteria.
- Regression tests cover derived-plan adoption before implementation or Plane module creation.
- The documented workflow matches the visible webapp controls and does not require hidden CLI steps.

## Cross-Repo Side Effects

None.

## Verify

- `bun test tests/features.test.ts tests/comments.test.ts tests/plan-annotations-api.test.ts`
- `cd webapp && bun test src/lib/task-model.test.ts src/components/ProofProvenancePanel.test.tsx`
- `bun run check`
- `cd webapp && bun run typecheck`
