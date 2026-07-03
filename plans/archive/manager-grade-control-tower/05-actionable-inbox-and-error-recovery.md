# Actionable needs-input inbox + error recovery
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/server.ts, src/land-ledger.ts, src/watchdog.ts, webapp/src/lib/dto.ts, webapp/src/lib/inbox.ts, webapp/src/components/views/InboxView.tsx, webapp/src/components/agent/AnswerControls.tsx, webapp/src/components/agent/AgentActions.tsx, webapp/src/components/layout/TopBar.tsx, webapp/src/App.tsx, tests/*, webapp/src/**/*.test.ts

## Goal

Make the needs-input queue clear blockers. It should not just list errored agents; it should rank pending work, root cause, and safe next actions across pending UI/tool requests, errors, land-ready work, health warnings, and observer/scout findings.

## Approach

- Keep current `agent.pending[]` answer path; do not replace `ClientCommand.answer`.
- Add a small read model/API, e.g. `/api/action-items?repo=`, composing existing data:
  - pending UI/tool requests from roster
  - errored/stalled agents
  - `landReady`/staged agents
  - blocked/diverged features/worktrees
  - health warnings from `/api/health`
  - land-failure ledger rows
  - `[observer]` / `[scout]` tagged Plane issues when Plane is configured
- Each row: severity, source, subject, rootCause, nextAction, target route, and optional existing command target.
- Inbox UI groups rows:
  - pending requests with `AnswerControls`
  - errored agents with restart/kill/remove/open transcript
  - land/review rows with open/land/verify where existing endpoints exist
  - health/governance rows as read-only next actions
- Make TopBar needs-input count a real navigation button to `#/inbox`.
- Render editor/select/confirm/input controls from enriched `PendingRequest` metadata from concern 01.
- Preserve oldest-first pending behavior inside each priority group.

## Cross-Repo Side Effects

None.

## Verify

- Pending confirm/select/input/editor rows answer through `ClientCommand.answer` and disappear when the manager emits the updated agent.
- Host tool requests are visibly riskier and never auto-approved by the inbox.
- Error row restart sends `restart`; kill sends `kill`; open transcript navigates to `#/console/<agentId>` or agent detail.
- Health warning and land-failure fixtures appear with root cause + next action, no fake Plane dependency when Plane is unconfigured.
- TopBar count click routes to inbox.
- Empty state distinguishes “all clear” from “daemon disconnected”.
