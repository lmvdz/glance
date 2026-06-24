# Project view — plannable task list + properties

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/ProjectView.tsx (new), webapp/src/components/project/TaskList.tsx (new), webapp/src/hooks/useTasks.ts (new), webapp/src/App.tsx
BLOCKED_BY: 01-task-data-model, 02-project-sidebar
VERIFY_BLOCKER: `grep -q "/api/tasks" src/server.ts` AND `test -f webapp/src/lib/projects.ts`

## Goal

The project view: for the selected repo, show its **features** (plan dirs) and under each its
**tasks** (Plane issues) as a plannable list — each task row showing title + key **properties**
(state, priority, blockedBy count, the executing agent's status if any). Selecting a task opens the
detail panel (concern 04). This is the piyaz "project view": sidebar drill (02) → this list → detail (04).

## Approach

### 1. `webapp/src/hooks/useTasks.ts` (new)
- `useProjectIssues(repo)`: fetch `/api/plane/issues?project=<repo>` (existing endpoint, `IssueRef[]`)
  via `apiGet`, refreshed on the same cadence `useSquad` uses for features (poll or the
  `features-changed` WS event). Returns `{ issues, loading }`. Plane-unconfigured (`501`/`null`) →
  empty list + a "Plane not configured" flag so the view degrades gracefully.

### 2. `webapp/src/components/views/ProjectView.tsx` (new)
- Props `{ repo, squad, selectedTaskId, onSelectTask }`.
- Filter `squad.features` to `f.repo === repo`; group the project's tasks under the feature that
  references them: a feature's `issueIdentifiers[]` → match `IssueRef.identifier`. Tasks not tied to
  any feature go under an "Unplanned" bucket.
- Render each feature as a section header (title + stage chip from `stageColorVar`) with its
  `<TaskList>` beneath. Empty project → the existing empty-state component.

### 3. `webapp/src/components/project/TaskList.tsx` (new)
- Props `{ issues, agentsByIssue, selectedId, onSelect }`.
- One row per task: status dot (Plane `state` → color), identifier (mono), name (truncate),
  property chips — priority, a 🔗N badge when `blockedBy.length`, and the executing agent's
  status ring when an agent's `issue.identifier` matches. Reuse `components/agent/status-dot` +
  `components/ui/badge`. Keyboard/aria: rows are buttons, `aria-selected`.

### 4. `webapp/src/App.tsx`
- Replace concern 02's placeholder with `<ProjectView repo={sel} squad={squad} selectedTaskId={...}
  onSelectTask={(id) => selectIn("project", repo + "/" + id)} />`; task selection encodes
  `#/project/<repo>/<taskId>` so 04's panel opens. Reuse the existing slide-over pattern from
  `FeaturesView.tsx` for the detail panel mount.

## Cross-Repo Side Effects
None. Consumes 01's `/api/tasks` only indirectly (04 owns that); this concern uses the existing
`/api/plane/issues` list + on-wire features/agents. Shares `App.tsx` with 02 (sequenced) and 04
(different render region: 04 adds the detail slide-over).

## Verify
- `cd webapp && bun run build` + `bun run check` clean.
- Manual: select a project → features render with their tasks; a task with a blocker shows 🔗N; a
  task an agent is running shows the agent status ring; clicking a task routes to `#/project/<repo>/<id>`.
