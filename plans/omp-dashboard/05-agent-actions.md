# Agent actions — control from the detail pane
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/agent/*, webapp/src/lib/api.ts

## Goal
Full agent control from the detail action bar + context menu: prompt (composer), interrupt, kill,
restart, remove (+delete worktree), and land / diff (Changes) / subagents.

## Approach
- `lib/api.ts` — an authed `fetch` wrapper around `/api/*` (Bearer from `lib/ws.ts` `token()`),
  plus a `command(cmd: ClientCommand)` helper (WS `send`, or `POST /api/command` `server.ts:678`).
- **Composer** — textarea → `{type:"prompt", id, message}`; Enter to send, steer while working.
- **Lifecycle buttons** — `interrupt` / `kill` / `restart` / `remove` (`{deleteWorktree}`) ClientCommands.
- **Land / diff / subagents** — `POST /api/agents/:id/land`, `GET /api/agents/:id/diff` (changed-files
  panel), `GET /api/agents/:id/subagents` (fan-out tree). Toasts on result.
- Reuse `AnswerControls` (concern 04) inside the detail for the open agent's own `pending[]`.

## Cross-Repo Side Effects
None. `lib/api.ts` becomes the shared HTTP seam for concerns 06/08/09.

## Verify
- Prompt an `idle` agent → it transitions to `working` and the transcript streams.
- Interrupt a `working` agent → it stops; restart → fresh run; remove → drops from roster.
- `landReady` agent → Land → success toast; Diff lists changed files; Subagents shows the tree.

## Resolution
lib/api.ts (authed GET/POST) + AgentActions (composer prompt, interrupt/restart/kill/remove, land) + Changes/Subagents tabs; AnswerControls reused inline in the detail. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0; `cd webapp && bun run build` + `bun run test` 14/0; runtime smoke OK).
