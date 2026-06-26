# Plane promotion renderer + status transitions

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/feedback.ts, src/plane.ts, src/squad-manager.ts, src/server.ts, tests/feedback-promotion.test.ts (new)
BLOCKED_BY: 01-feedback-domain-persistence.md

## Goal

Promote accepted feedback into an agent-ready Plane issue that the existing omp-squad dispatcher can pick up.

## Approach

### 1. Pure renderer in `src/feedback.ts`
Add `renderFeedbackPlaneIssue(item, validations, reward): { title: string; descriptionHtml: string }`.

The body must include predictable sections:

```md
## User Feedback
Kind:
URL:
User segment / metadata:
Reward campaign:

## Evidence
Screenshot: <private attachment path or admin URL>
Browser / viewport:
Repro notes:

## Validation
Responses:
Pain score:
Confidence:

## Acceptance Criteria
- ...

## Verification
- ...

## Scope Boundary
- Do not implement unrelated roadmap items.
```

Keep template generation pure and tested. The server route should not build markdown inline.

### 2. Plane creation seam
Reuse `createPlaneIssue(repo, name, descriptionHtml)` from `src/plane.ts`. If it lacks any needed return field, extend it there rather than adding a second Plane client.

### 3. Manager/server API
Add authenticated operator routes:

- `POST /api/feedback/items/:id/accept`
- `POST /api/feedback/items/:id/reject`
- `POST /api/feedback/items/:id/promote`

`promote` requires status `accepted` or `needs-validation`, calls Plane creation, stores returned `IssueRef` on the feedback item, and transitions status to `promoted`. Duplicate promote returns the existing `planeIssue` idempotently.

### 4. Dispatcher handoff
No new agent spawn path. Once the Plane issue exists, existing auto-dispatch (`Dispatcher` in `src/dispatch.ts`, wired by `SquadManager.start`) sees it through `listPlaneIssues` and routes it like any other work.

## Cross-Repo Side Effects

Plane issue content becomes the handoff contract for agents. Do not alter dispatcher selection logic unless a promoted issue needs a marker; prefer the issue body over title magic.

## Verify

- `tests/feedback-promotion.test.ts`: renderer includes evidence, validation, reward, acceptance criteria, verification, and scope sections.
- Promotion against a fake Plane server creates one issue and stores its `IssueRef`.
- Re-promoting the same feedback is idempotent and does not create a second Plane issue.
- Rejected feedback cannot be promoted.

## Resolution

Implemented pure Plane issue rendering, authenticated accept/reject/promote routes, idempotent Plane promotion through the existing `createPlaneIssue` seam, and promotion tests with a fake Plane server.
