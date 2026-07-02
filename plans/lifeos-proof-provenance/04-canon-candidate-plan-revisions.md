# Canon candidate plan revisions
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/comments.ts, src/server.ts, src/squad-manager.ts, webapp/src/lib/dto.ts, webapp/src/components/TaskDetail.tsx, tests/comments.test.ts, tests/plan-annotations-api.test.ts

## Goal

Treat agent-written plan revisions as low-trust candidates that must be accepted, rejected, or superseded before they become canon.

## Approach

- Extend the existing comment/artifact model if possible; avoid a new store unless state cannot fit cleanly.
- Candidate fields should include feature id, plan path, producing agent id, optional run id/trace id, summary, diff/patch reference, state, created/updated timestamps, and reviewer.
- Add feature-scoped endpoints to list, accept, reject, and supersede candidates.
- Acceptance should apply the candidate plan patch or mark the already-applied patch as accepted, then emit `features-changed` so context refreshes.
- Rejection should preserve provenance and reason without mutating plan markdown.
- Wire the existing plan annotation "send to planner" flow so planner output can register a candidate instead of silently becoming canon.
- Keep candidate content as data. Do not let candidate text become operator/system instruction in console prompts.

## Acceptance Criteria

- Agent-written plan revisions appear as reviewable candidates before the UI treats them as canon.
- Each candidate shows its producing agent, run/proof reference when available, affected plan path, summary, and current review state.
- Operators can accept, reject, or supersede a candidate without losing provenance.
- Accepting a candidate refreshes feature context and plan-derived criteria; rejecting one preserves the review record without mutating markdown.
- Candidate text is treated as data and never as an instruction source for operators, agents, tools, or tests.

## Cross-Repo Side Effects

None. If future planner agents edit repos other than `omp-squad`, the candidate record must still live under the daemon state for the source repo being planned.

## Verify

- `bun test tests/comments.test.ts tests/plan-annotations-api.test.ts`
- `bun run check`
- `cd webapp && bun run typecheck`
