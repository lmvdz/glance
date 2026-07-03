# Integrated Console Center
STATUS: cancelled
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/ConsoleView.tsx, webapp/src/components/spawn/NewWork.tsx, webapp/src/components/palette/CommandPalette.tsx, webapp/src/components/workbench/*

## Goal
Make Control Tower the always-available middle command surface: talk to the daemon, spawn agents, review proposed changes, and see live preview/detail in the right rail.

## Approach
- Keep `ConsoleView` as a route, but expose its input composer for embedding in the workbench middle pane.
- Upgrade spawn flow toward the reference image: intent textarea, profile picker, smart recommendation cards, advanced options.
- Proposed changes should open in right rail as `diff`, `settings`, `profile`, or `capability` detail subjects.
- Do not create fake apply buttons. If a command is not backed by daemon API yet, render disabled with missing contract copy.

## Cross-Repo Side Effects
May require small daemon API additions later; this concern only wires existing console/spawn behavior.

## Verify
- Starting a chat still sends `apiPost('/api/console')`.
- Existing free-standing console agents still list and open.
- Command palette can jump to console.
