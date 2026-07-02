# App shell navigation + full issue workspace
STATUS: open

> 2026-07-01 reconcile: marked done but never built (2026-06-30 audit, re-verified today) — none of
> the TOUCHES files exist (`webapp/src/components/layout/`, `views/`, `palette/`, `workbench/` are
> absent; no hash routing). The `55e2637` shell replacement went a different direction (TaskList/
> TaskDetail/AssistantChat shell); if this concern still matters, re-plan it against that shell.
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/App.tsx, webapp/src/components/layout/Sidebar.tsx, webapp/src/components/layout/TopBar.tsx, webapp/src/components/palette/CommandPalette.tsx, webapp/src/components/views/ConsoleView.tsx, webapp/src/components/views/FeaturesView.tsx, webapp/src/components/views/ProjectView.tsx, webapp/src/components/DetailPanel.tsx, webapp/src/components/project/TaskDetail.tsx, webapp/src/components/project/CommentsPanel.tsx, webapp/src/components/workbench/DetailRail.tsx, webapp/src/lib/projects.ts, webapp/src/**/*.test.ts

## Goal

Make Control Tower and missions navigable manager workspace routes, not isolated/fullscreen or scroll-lost side panels. Selecting a mission/issue should dive into a full issue screen with plan, comments, trace, and a page-aware assistant agent.

## Approach

- Remove the `App.tsx` `view === "console"` special case that drops Sidebar/DetailRail, or replace it with an equivalent in-console rail that keeps global navigation visible.
- Extend hash routing conservatively; no router dependency:
  - `#/console/:agentId?`
  - `#/features/:featureId`
  - `#/project/:repo/task/:taskId`
  - preserve old `#/features` and `#/project/:repo` links.
- Move `FeaturesView` detail out of the absolute slide-over and into a route-level workspace. Keep the slide-over only as a narrow-screen quick preview if it does not trap scroll.
- Move `ProjectView` task detail from absolute right panel into the same route-level workspace. Header/close/back stays sticky; detail body scrolls independently.
- Compose issue workspace from existing pieces: `TaskDetail`, `CommentsPanel`, feature pipeline/verify/land actions, agent transcript, blockers, and trace/graph links.
- Add “Ask about this issue” / “Plan next change” action that opens Control Tower with fenced page context: issue id/title/body sections, plan dir/concern, unresolved comments, active agents, current route. This is operator-submitted context, not hidden steering.
- Keep all comments through existing `/api/comments`; no second comment store.

## Cross-Repo Side Effects

None.

## Verify

- Direct-load `#/console`, `#/console/<agentId>`, `#/features/<featureId>`, and `#/project/<encoded-repo>/task/<taskId>`.
- Control Tower shows Sidebar/TopBar navigation and command palette can leave the page.
- Long task/feature detail scroll keeps header/actions visible; no detached side panel gets lost higher on the page.
- Comments add/resolve still persist and feed workflow context where feature id exists.
- Page-aware agent prompt includes fenced route context once and does not duplicate it on every follow-up.
