# Regression gate default flip

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/land.ts, src/runtime-settings.ts, .env.example, tests/land-regression-gate.test.ts, tests/runtime-settings.test.ts (verify only)

## Goal

`OMP_SQUAD_REGRESSION_GATE` flips from opt-in (`=== "1"`, default OFF) to opt-out (`!== "0"`, default ON), matching the pattern every other autonomy/safety flag in this codebase already uses (`OMP_SQUAD_AUTOLAND`, `OMP_SQUAD_STALE_GATE`, `OMP_SQUAD_AUTORESOLVE`, etc. — all `!== "0"`). Register it in the runtime-settings flag registry so the webapp can see and toggle it like every other flag, instead of it being an invisible raw `process.env` read.

## Approach

### 1. `src/land.ts:204-207` — the flip

Verified current code:

```ts
/** On by default when OMP_SQUAD_REGRESSION_GATE=1. */
function regressionGateEnabled(): boolean {
	return process.env.OMP_SQUAD_REGRESSION_GATE === "1";
}
```

Change to:

```ts
/** On by default; set OMP_SQUAD_REGRESSION_GATE=0 to disable the post-merge full-suite regression check. */
function regressionGateEnabled(): boolean {
	return process.env.OMP_SQUAD_REGRESSION_GATE !== "0";
}
```

This is the exact pattern already used two functions below it in the same file — verified `autoresolve()` (`land.ts:449-452`, `!== "0"`) and `staleGateEnabled()` (`land.ts:454-457`, `!== "0"`); match their doc-comment phrasing too ("On by default; set X=0 to disable...").

### 2. Register in `src/runtime-settings.ts` FEATURE_FLAGS

Verified current structure: the `FeatureFlagKey` union type is `runtime-settings.ts:6-18`; the actual `FEATURE_FLAGS` array (12 entries today) is `runtime-settings.ts:38-51`. Representative entry (line 44): `{ key: "OMP_SQUAD_AUTODRIVE", label: "Self-drive loop", description: "Continuously verify, land, self-heal, and escalate idle work.", defaultEnabled: true, restartRequired: true }`. `FeatureFlagDefinition` fields (`runtime-settings.ts:20-26`): `key`, `label`, `description`, `defaultEnabled`, `restartRequired?`.

`OMP_SQUAD_REGRESSION_GATE` is **not currently in this union or array at all** — it exists only as a raw `process.env` check, disconnected from the flag system the webapp reads. Add it to both:

```ts
// in the FeatureFlagKey union, runtime-settings.ts:6-18:
	| "OMP_SQUAD_REGRESSION_GATE"

// in the FEATURE_FLAGS array, runtime-settings.ts:38-51:
	{ key: "OMP_SQUAD_REGRESSION_GATE", label: "Regression gate", description: "Run the full suite on merged main after a land and block on any newly introduced failure.", defaultEnabled: true, restartRequired: false },
```

`restartRequired: false` is correct here — unlike the `AUTO*` flags (which gate long-lived loops/timers started at boot), `regressionGateEnabled()` is read fresh on every land call, so toggling it via the runtime-settings store takes effect on the next land with no restart.

### 3. `.env.example`

Add (or update, if a commented-out/stale line already exists — grep the file first):

```
# Full-suite regression check after every merge, on by default. Set to 0 to disable.
OMP_SQUAD_REGRESSION_GATE=1
```

### 4. Invert `tests/land-regression-gate.test.ts`

Verified: the file's flag-unset test is at **lines 94-105** (not 94-123 as originally cited — 107-120 and 122-134 are two separate flag`=1` tests, not part of the unset-case block), titled `"flag unset + acceptance gate passes + branch introduces NEW_RED → land allowed (current behavior preserved)"`. Read the full test body at implementation time and:

- Rename it to reflect the NEW default behavior (e.g. `"flag unset (default ON) + acceptance gate passes + branch introduces NEW_RED → land BLOCKED"`) and invert its final assertion from "land allowed" to "land blocked" (mirroring whatever assertion shape the two adjacent `=1` tests at 107-120/122-134 already use for the blocked case — copy that shape rather than inventing a new one).
- Add a NEW explicit opt-out test asserting the OLD behavior is still reachable: set `OMP_SQUAD_REGRESSION_GATE=0` explicitly, same NEW_RED branch/acceptance-pass setup, assert land is allowed (this is the test that proves the escape hatch mentioned in DESIGN.md's Risk #1 mitigation actually works, not just that the code compiles).
- Leave the two existing `=1` tests (107-120, 122-134) untouched — their behavior is unaffected by this flip.

### 5. Check for incidental breakage

- `tests/runtime-settings.test.ts` — verified no existing assertion references `OMP_SQUAD_REGRESSION_GATE` today (it wasn't in the registry). Check whether any test asserts a fixed `FEATURE_FLAGS.length` or enumerates all keys by count (e.g. `expect(states.length).toBe(12)`) — if so, update that count to 13. The two existing tests found during verification (AUTODISPATCH-pinning around lines 28-34, `OMP_SQUAD_OBSERVE_AUTOFIX` persistence around 36-47) do not appear to assert a total count, but confirm at implementation time.
- `tests/factory-status.test.ts` — verified zero references to `OMP_SQUAD_REGRESSION_GATE`; no change expected, but run the full file to confirm nothing implicitly depended on the gate defaulting OFF (e.g. a test that lands a branch with a pre-existing red baseline and expects a clean merge with no regression-gate suite run at all).

## Cross-Repo Side Effects

None — single repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/land-regression-gate.test.ts` — inverted unset-case test blocks the NEW_RED land; new explicit `=0` test allows it; the two pre-existing `=1` tests still pass unchanged.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/runtime-settings.test.ts` — `OMP_SQUAD_REGRESSION_GATE` appears in `featureFlagStates()` output with `defaultEnabled: true`; existing AUTODISPATCH/OBSERVE_AUTOFIX assertions unaffected.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/factory-status.test.ts` — unaffected.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test` (full suite) — no other test implicitly assumed the old default.
- `bun run check`

## Resolution

Closed 2026-07-04 via commit 8bbfffc on branch worktree-research-direct-vs-glance. OMP_SQUAD_REGRESSION_GATE flipped to default-ON (!== "0"), registered in runtime-settings FEATURE_FLAGS, .env.example updated, tests inverted + explicit =0 opt-out case.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).
