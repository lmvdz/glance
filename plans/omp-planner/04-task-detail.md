# Task detail — description + acceptance criteria + context preview + properties

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/project/TaskDetail.tsx (new), webapp/src/lib/dto.ts, webapp/src/lib/api.ts (reuse)
BLOCKED_BY: 01-task-data-model
VERIFY_BLOCKER: `grep -q "/api/tasks" src/server.ts`

## Goal

The piyaz task panel: open a task and see its **description**, **acceptance criteria**, a
**context-bundle preview**, and **properties** — the high-value half of this whole plan. Consumes
concern 01's `GET /api/tasks/:id?repo=` (`TaskDetail`).

## Approach

### 1. `webapp/src/lib/dto.ts` — mirror `TaskDetail`
Add the `TaskDetail` interface (copy of the server type from concern 01: id/identifier/name/state/
priority/labels/url/blockedBy/body/tier2{description,acceptanceCriteria,verification,scope}). This is
the existing convention — `dto.ts` is a hand-kept subset mirror of `src/types.ts` (see file header).

### 2. `webapp/src/components/project/TaskDetail.tsx` (new)
- Props `{ repo, taskId, onClose }`. Fetch `apiGet<TaskDetail>('/api/tasks/' + encodeURIComponent(taskId)
  + '?repo=' + encodeURIComponent(repo))` on mount/`taskId` change; skeleton while loading; error-state
  on `null`.
- Layout (slide-over, mounted by concern 03 like `FeaturesView`'s panel):
  - **Header:** identifier (mono) + name + a Plane deep-link (`url`).
  - **Properties** row: state chip, priority, labels (badges), `blockedBy` count → `components/ui/badge`.
  - **Description:** `tier2.description || body` rendered via the existing
    `components/agent/Markdown.tsx` (reuse — no new markdown dep).
  - **Acceptance criteria:** `tier2.acceptanceCriteria` in its own card (the piyaz "AC" block); hide
    the card when empty.
  - **Context bundle preview:** a collapsible card showing `tier2.scope` + `tier2.verification` +
    `blockedBy` list — omp-squad's per-task context bundle. Hide sub-parts that are empty.
- Use existing `card`/`badge`/`skeleton`/`empty-state`/`error-state` primitives; follow the
  established Tailwind v4 conventions. No new dependency.

## Cross-Repo Side Effects
None. Read-only consumer of 01's endpoint. Shares `App.tsx`/the slide-over only via concern 03's mount
point (03 renders `<TaskDetail>`); this concern owns the component, not the route wiring.

## Verify
- `cd webapp && bun run build` + `bun run check` clean.
- The SPA test harness renders `TaskDetail` against a stubbed `/api/tasks/:id` response and asserts the
  AC card shows when `acceptanceCriteria` is non-empty and is absent when empty.
- Manual: open a task with a Tier-2 body → description + acceptance criteria + scope/verification +
  properties render; a bare issue (no Tier-2) → description falls back to `body`, AC card hidden.
