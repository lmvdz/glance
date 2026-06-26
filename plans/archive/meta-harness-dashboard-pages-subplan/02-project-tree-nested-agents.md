# Project Tree + Nested Agents
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/layout/Sidebar.tsx, webapp/src/lib/projects.ts, webapp/src/hooks/useSquad.ts, webapp/src/components/workbench/ProjectTree.tsx

## Goal
Replace the flat left nav with a project/repo-first tree where each project can expand to show its agents, tasks, conflicts, and runs.

## Approach
- Reuse `groupProjects(squad.features, squad.agents)` as the root.
- Add active project rows with counts: agents, waiting, conflicts, features.
- Inside each project, show collapsible active agents grouped by status/profile.
- Clicking project sets middle view to project/workbench; clicking agent opens right rail agent detail.
- Keep global nav groups below the project tree: Fleet, Profiles, Tournaments, Observability, Governance, Settings.
- Add keyboard tree basics: arrow up/down, enter, space, left/right collapse.

## Cross-Repo Side Effects
None.

## Verify
- Projects with zero agents still show.
- Agents without repo fall under `Unassigned`.
- No `<div onClick>`; tree rows are buttons.
