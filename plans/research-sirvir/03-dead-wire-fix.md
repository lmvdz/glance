# Dead-wire fix — reconnect the interactive spawn router (DB-safe)

STATUS: in-review (PR feat/sirvir-04-03-cost-and-wire — wired + regression-tested, see notes)
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/server.ts, src/squad-manager.ts, src/smart-spawn.ts

## Implementation notes (Wave 3, W4)
Line numbers in this doc's "Evidence" section were stale against current main (server.ts had grown
to 2306 lines; the route lives at line 1411, not 1376) but the dead wire itself was CONFIRMED exactly
as described: `planSpawn(prompt, { cwd, candidates })` with no outcomes/scoreboard. Also confirmed via
git archaeology that this is NOT related to the #103 legacy-webapp removal — the route (added in
5b25093) survived every refactor untouched except a bootstrap-admin auth reindent (cfc4bd5); it was
simply never updated when concern 07/02 landed the outcomes plumbing.

Followed the concern's approach exactly: added `SquadManager.spawnScoreboard(): Promise<Scoreboard>`
(mirrors `allReceipts()`/`shadowCostCheck(this.stateDir, …)`, closes over the manager's PRIVATE
`this.stateDir` — never a bare `resolveStateDir()`) since concern 04 changed `planSpawn`/`assemblePlan`
to take a `Scoreboard` rather than an `OutcomesReader` (per 04's own note: "if concern 04 has changed
the signature... align 03 with it"). `server.ts`'s route (`manager` there is the per-request
`managerFor(actor)`-resolved, potentially org-scoped instance — verified this IS the DB-mode-unsafe
manager the trap warns about) now does `envBool("OMP_SQUAD_MODEL_OUTCOMES", false) ? await
manager.spawnScoreboard() : undefined` and passes it to `planSpawn`. Note: `#113`'s
`observabilityManagers`/`handleObservability` refactor is a GET-only fleet-wide aggregation path and
does not touch `/api/spawn` (a POST route resolved against the single per-request `manager`) — verified
no interaction.

Verify: tests/spawn-route.test.ts — an in-process `SquadServer`/`SquadManager` (real HTTP, real route,
`SquadManager.makeDriver` swapped for a `FakeDriver` so `create()` doesn't spawn a live harness process,
`omp` stripped from `$PATH` so `infer()` degrades to heuristics instantly) with a seeded non-empty,
family-keyed ledger + `OMP_SQUAD_MODEL_OUTCOMES=1` asserts the shift surfaces in `plan.model`/
`plan.reason` from the REAL `/api/spawn` response; a flag-off control on the same seeded ledger proves
the positive assertion isn't a tautology.

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
