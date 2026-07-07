# Dead-wire fix — reconnect the interactive spawn router (DB-safe)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/server.ts, src/squad-manager.ts, src/smart-spawn.ts

## Goal
Make the interactive `POST /api/spawn` path actually pass an outcomes reader into `planSpawn`, so the outcome-driven shift can fire there (once concerns 01+02 give it fuel and coherent keys). Explicitly scoped to the INTERACTIVE human spawn box — this is NOT the fleet path (the fleet never calls `planSpawn`; that's concern 05).

## Evidence it's broken
`server.ts:1376`: `planSpawn(prompt, { cwd: process.cwd(), candidates: discoverRepos(...) })` — no `outcomes`. Inside `shiftedModel` (`smart-spawn.ts:60`), `if (... || !outcomes) return {}` short-circuits, so even with `OMP_SQUAD_MODEL_OUTCOMES=1` the live path does zero shifting. `readModelOutcomes` is already imported at `server.ts:68`.

## Approach
- Do NOT call bare `resolveStateDir()` at the call site (red-team CONFIRMED trap): in DB mode the `manager` at `/api/spawn` is org-scoped with a private `stateDir = root/orgs/orgId` (`manager-registry.ts:108`), while `resolveStateDir()` returns the global root — so the reader would read the wrong, empty ledger for every tenant while recording happens under the org dir.
- Add `SquadManager.modelOutcomesReader(): OutcomesReader` that closes over the private `this.stateDir` (mirrors the existing `shadowCostCheck(this.stateDir, …)` call pattern; matches how the manager exposes other derived accessors rather than leaking `stateDir`). It should build the reader from `readModelOutcomes(this.stateDir)` and apply concern-02's `modelFamily` normalization so lookups hit.
- At `server.ts:1376`, pass `outcomes: manager.modelOutcomesReader()`.
- If concern 04 has changed `planSpawn`/`assemblePlan` to take a `Scoreboard` instead of an `OutcomesReader`, expose `manager.spawnScoreboard()` instead and pass that — keep this concern aligned with 04's final signature (they share `smart-spawn.ts`; do them as one agent or sequentially, 02→04→03).

## Cross-Repo Side Effects
None.

## Verify
Regression test that drives the real `/api/spawn` route in-process (`new SquadServer(manager)`, no live `omp` binary needed — `infer()` falls back to heuristics on timeout) with a seeded non-empty ledger + `OMP_SQUAD_MODEL_OUTCOMES=1`, and asserts the shift surfaces in `plan.model` / `plan.reason`. The existing tests hit `assemblePlan` directly and would pass even with the wire cut — this test must exercise the server call site.
