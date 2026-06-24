# Spawn & new work
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/spawn/*, webapp/src/lib/api.ts

## Goal
Create work without the CLI: spawn an agent (repo + task + flags), create a feature, create from a
plan dir, and auto-feature (a goal that spawns the research→plan→implement workflow).

## Approach
- `SpawnModal` (Dialog) — repo (Select/path), task (textarea), model / approvalMode / thinkingLevel
  (Select, from `CreateAgentOptions` `types.ts:306`) → `POST /api/spawn` (`{prompt}` `server.ts:584`)
  or `create` ClientCommand (`{options}`) for the full flag set.
- **Features** — `NewFeature` → `POST /api/features` (`{title, repo}`); `FromPlan` → `POST
  /api/features/from-plan` (`{repo, planDir, title}`); `AutoFeature` → `POST /api/features/auto`
  (`{goal, repo}`).
- A "+ New" affordance in the topbar/sidebar opens the relevant modal per active view.

## Cross-Repo Side Effects
None. Uses `lib/api.ts` (concern 05).

## Verify
- Spawn → a new agent appears in the roster and its transcript streams.
- New / from-plan feature → appears on the board (concern 08).
- Auto-feature with a goal → a workflow agent shows up, advancing through stages.
