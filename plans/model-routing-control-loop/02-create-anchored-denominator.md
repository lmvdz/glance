# Create-anchored denominator + non-landing-kind exclusion
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/model-outcomes.ts, src/autonomy.ts (read), new src/is-landing-unit.ts (or a helper in an existing module)

## Goal
Make merge-rate's denominator honest. A receipts-based denominator structurally excludes the worst failures — units that die before `finalizeRun` never append a receipt (the documented units-never-commit pattern) — so merge-rate reads inflated. Anchor the denominator on the durable dispatched-unit **roster** instead, and exclude kinds that by design never land (or they read as false failures).

## Approach
The roster is durable at create: `createWithId` constructs `PersistedAgent` (~`:3057`), inserts it into `this.agents` (~`:3141`), and `await this.persist()` (~`:3184`) writes a full snapshot to `<stateDir>/state.json` before create returns. So every dispatched unit that survives its own create() leaves an `agentId`-keyed record even if it later crashes. (Residual leak: a crash *during* the create handshake, between construct and persist, leaves no row — document it, don't chase it.)

1. **Author `isLandingUnit(rec | dto): boolean`** (new small module, or colocate in `model-outcomes.ts`). Returns false for any of:
   - `kind === "flue-service"` (`src/types.ts:55`, set at `squad-manager.ts:3026`) — synthetic repo, no branch.
   - `executionRole === "observer"` (`src/types.ts:58`) — reproduce-and-report, never commits.
   - effective autonomy `mode === "observe"` (`src/autonomy.ts:3`, incl. runtime-capped via `effectiveAutonomyMode`/`blockedReason`, `autonomy.ts:36`) — `land` stripped from actions (`autonomy.ts:52`).
   - `verifyMode === "observe"` (`src/types.ts:872/950`) — the observe workflow never fixes/commits.
   Returns true for `kind` in {`omp-operator`,`workflow`}, `executionRole==="tester"` (tdd still lands), and `adopted` units (they land directly via the orchestrator). Add a unit test enumerating each case so a future `kind` can't silently slip through as a false failure.

2. **Denominator = landing-kind roster.** When building the outcome set (consumed by C05), enumerate `[...this.agents.values()]` (and/or read `state.json`) filtered by `isLandingUnit`. A roster unit with a successful land row is the numerator; a roster unit with no land row is counted as a **failure** (honest). This dissolves the drafted "abandoned sweep" as the source of truth — the roster *is* the denominator. Any periodic sweep degrades to best-effort enrichment of late land outcomes, not the population count.

3. Keep `recordModelOutcome` (`:2337`) as-is for now (it already keys `(model, tier)` at land); C03 adds the richer joined row. This concern's deliverable is the **denominator definition + `isLandingUnit`**, wired so C05 can compute a correct merge-rate.

## Cross-Repo Side Effects
None outside omp-squad. `isLandingUnit` is new and additive; existing land logic is unchanged (we read the roster, we don't alter the land gate).

## Verify
- Create one of each: a normal coding unit, a flue-service unit, an observe-mode unit, an observer-role unit. Confirm `isLandingUnit` returns true only for the first.
- Kill a dispatched unit after create but before it lands (e.g. stop the daemon mid-run); confirm it still appears in `state.json` and is counted as a denominator failure, not silently dropped.
- Confirm a plan-only/observe unit does NOT appear as a false failure in the denominator.

## Resolution
Closed — commits `92aacea` + `d…` (review fix). New `src/is-landing-unit.ts` with `isLandingUnit(dto)` + `landingRosterOf()`; `SquadManager.landingRoster()` wraps `landingRosterOf(this.list())`, and `list()` returns the full in-memory roster (incl. crashed-but-persisted units, rehydrated via `adoptOrphanedAgents`) — the opus review confirmed the critical denominator check: hard-crashed units ARE counted as failures. **Review fix applied:** the observe exclusion originally keyed off `effectiveMode`, which collapses to "observe" on any `blockedReason` (incl. `dto.error`/`dto.pending`) — that silently dropped errored/abandoned units (real failures) and re-inflated merge-rate. Fixed to key off the static `autonomyMode` (types.ts:657); added a regression test. 13 `isLandingUnit` tests + 35 adjacent pass; tsc clean. Uses `dto.effectiveMode`→now `dto.autonomyMode`; no "abandoned sweep" built (roster IS the denominator, per spec).
