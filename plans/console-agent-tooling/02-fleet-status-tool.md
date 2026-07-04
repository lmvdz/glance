# squad_fleet_status tool
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/console-tools/fleet-status.ts (new), src/console-tools.ts, tests/console-tools.test.ts

BLOCKED_BY: 01

## Goal
The console agent can answer "what's the fleet doing?" from live state: roster with per-agent status/stage/issue/model, factory liveness, and a meaningful-activity rollup.

## Approach
Registry entry `squad_fleet_status`, `readOnly: true`, parameters `{ windowHours?: number (default 24, max 72) }`.
Handler assembles (all cheap synchronous/near-sync reads, verified):
- Roster: `manager.list()` (`src/squad-manager.ts:960`) — per agent: name, status, stage, issue identifier, model, ageMs, landReady/pending flags. Include worktree-dirty marker only if cheaply available on the DTO (do NOT run git here — that's concern 03/05's job).
- Factory: `manager.factoryStatus()` (`:3552`).
- Activity: `manager.automationActivity({ windowMs, meaningfulOnly: true, limit: 30 })` (`:3541`) — render as compact lines; include the error count.
Output: markdown, self-capped ~8KB (truncate roster at 40 agents with a "+N more" line).

## Cross-Repo Side Effects
None.

## Verify
- Test with `fakeRec` + a stub manager exposing canned `list`/`factoryStatus`/`automationActivity`: output contains each section, respects the cap, `windowHours` clamped.
- Manual (post-deploy): ask the webapp chat "what's the fleet doing?" — answer cites live roster, no gate prompt appears.
