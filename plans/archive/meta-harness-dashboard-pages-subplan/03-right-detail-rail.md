# Right Detail Rail
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/DetailPanel.tsx, webapp/src/components/agent/*, webapp/src/components/project/*, webapp/src/components/workbench/DetailRail.tsx

## Goal
Create one collapsible right rail for whatever the operator clicked: agent, project, feature, task, profile, run, diff, audit chain, settings section, or live preview.

## Approach
- Define a small `DetailSubject` union in a workbench module.
- Implement `DetailRail` with tabs only when the subject supports them.
- First supported subjects: `agent`, `feature`, `task`, `diff`, `audit`, `settings`.
- Move existing `DetailPanel`, `TaskDetail`, `AgentChanges`, `Transcript`, and controls into subject renderers.
- Add an empty rail state that explains what can be selected.
- Rail collapse state persists in localStorage.

## Cross-Repo Side Effects
None.

## Verify
- Selecting an agent opens conversation/actions/context.
- Selecting a task opens Plane detail.
- Selecting diff/provenance from landing/audit pages opens rail without route loss.
- Escape closes rail and returns focus to trigger.
