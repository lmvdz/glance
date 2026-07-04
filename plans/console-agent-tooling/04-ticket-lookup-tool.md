# squad_ticket_lookup tool
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/console-tools/ticket-lookup.ts (new), src/console-tools.ts, tests/console-tools.test.ts

BLOCKED_BY: 01

## Goal
The console agent can resolve "OMPSQ-418" (or "list open tickets") to real state — name, status, description, blockers — instead of guessing from the id. Would have exposed the 417≡419/418≡420 duplicate pairs instantly.

## Approach
Registry entry `squad_ticket_lookup`, `readOnly: true`, parameters `{ identifier?: string, repo?: string, includeAllStates?: boolean }`.
Handler uses the daemon's own Plane layer (`src/plane.ts`, env-driven via `readConfig()` `:32-53`):
- Guard: `planeConfigured()` (`:326`) → friendly "Plane not configured" (the webapp's known daemon-readConfig-null failure mode must degrade into words, not an exception).
- `identifier`: `fetchIssueDetail(repo, id)` (`:242`) — name, state, priority, description (truncate 2KB), blockers, Tier-2 presence.
- No identifier: `listPlaneIssuesAllStates(repo)` (`:219`) when `includeAllStates`, else `listPlaneIssues(repo)` (`:165`, cached 15s) — identifier + name + state table, cap 50 rows.
- `repo` defaults to the console agent's repo (`rec.options.repo`); validate against `planeRepos()` (`:331`).

## Cross-Repo Side Effects
None (read-only Plane API usage through existing cached helpers).

## Verify
- Tests: stub the plane module (or inject fetchers if the module shape allows): detail render, list render + cap, unconfigured message, unknown identifier isError.
- Manual: "what is OMPSQ-422 about?" in the webapp chat returns the observer-hygiene ticket body.
