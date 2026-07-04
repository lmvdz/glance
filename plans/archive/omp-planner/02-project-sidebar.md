# Project model + drill-down sidebar

STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/projects.ts (new), webapp/src/components/layout/Sidebar.tsx, webapp/src/App.tsx
BLOCKED_BY: —

## Goal

Replace the flat global nav with a piyaz-style **project drill-down**: the sidebar lists projects
(repos), and selecting one opens its project view. The existing global items (Inbox/Agents/Graph/
Audit/Network) stay as a secondary section; **Features** becomes per-project. Client-only — uses
data already on the wire (`/api/projects`, `/api/features`, the WS roster via `useSquad`).

## Approach

### 1. `webapp/src/lib/projects.ts` (new, pure)
```ts
export interface Project { repo: string; name: string; featureCount: number; agentCount: number; waiting: number; }
export function groupProjects(features: FeatureDTO[], agents: AgentDTO[]): Project[]
```
- `name` = repo basename. `featureCount` = features in repo. `agentCount` = agents whose `repo` matches.
- `waiting` = agents in repo with status `input`|`error` (drives the attention badge).
- Sort: projects with `waiting > 0` first, then by name. Pure → unit-tested in concern 05.

### 2. `webapp/src/components/layout/Sidebar.tsx`
- Add a **Projects** section above the global `ITEMS`: render `groupProjects(...)` as a list; each row
  shows name + featureCount, an attention dot when `waiting > 0`. Selecting sets the route to the
  project view (concern 03). Keep the existing global items below a divider.
- Extend `View` union with `"project"`; selecting a project routes `#/project/<repo>` (repo URI-encoded).
- Reuse the existing button/active styling already in this file (don't restyle).

### 3. `webapp/src/App.tsx`
- Add `"project"` to `VIEWS` and route it: when `view === "project"`, `sel` = the selected repo →
  render `<ProjectView repo={sel} squad={squad} .../>` (component from concern 03; until 03 lands,
  a placeholder is acceptable for THIS concern's own build, but 03 replaces it).
- `useSquad` already exposes `features`/`agents`; pass through. No transport change.

> SAME-FILE NOTE: `App.tsx` is co-edited by concern 03 (which adds the real ProjectView render).
> Sequence `02 → 03`; 03 receives this diff.

## Cross-Repo Side Effects
None. New leaf module + two small webapp edits.

## Verify
- `cd webapp && bun run build` succeeds; `bun run check` (webapp tsc) clean.
- Manual: sidebar lists each repo as a project; a repo with a waiting agent shows the attention dot;
  clicking routes to `#/project/<repo>`.
- (Unit test for `groupProjects` lives in concern 05.)
