# Split the land-gate into ordered fail-fast stages with per-stage receipts
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/intake.ts, src/proof.ts, src/gate-runner.ts, src/types.ts

## Goal
The land-gate runs as an ordered, cheap-first, fail-fast sequence of stages (typecheck → test) that
records a per-stage receipt, so a gate failure says *which* stage failed and stops at the first red
one — instead of one opaque `&&`-joined command whose failure is undifferentiated.

## Approach
1. **Split at the source, not by re-tokenizing.** `detectVerify` (src/intake.ts:124-141) builds a
   `string[]` of commands and `.join(" && ")`s them (~intake.ts:135). Expose the structured list
   (e.g. `detectVerifyStages(repo): {name,command}[]`) instead of/alongside the joined string. This
   avoids the silent-bad-land risk of splitting a joined shell string (which would lose `cd`/`export`/
   quoted-`&&` semantics). For a repo whose verify is a single opaque custom command, that's one stage.
2. Add `stages?: StageResult[]` to `Proof` (src/proof.ts), `StageResult = { name, command, exitCode,
   durationMs }`. Additive, defaults `undefined` — fully backward-compatible.
3. In the pre-land gate (`runProof`, src/proof.ts:227-287), run each stage via the existing stateless
   `gateExec`/`execGatedCommand` (they already share a cached docker probe), **fail-fast** on the first
   non-zero exit, and record each stage's `StageResult` onto the `Proof`.
4. **Observability-only (explicit non-goal):** stages do NOT drive the `DoneProof` grade
   (`green|red-baseline|unverified`), which is set elsewhere by different logic. Do not thread stages
   into the grade or claim the grade "considers stages" — that's out of scope and would be a larger,
   riskier change. The win here is *legibility + fail-fast*, not a new grade.
5. Surface the failing stage name in the gate failure reason/detail so the operator sees "typecheck
   failed" not just "gate failed".

## Cross-Repo Side Effects
None.

## Verify
- Unit test: a repo with `typecheck && test` produces two ordered stages; a typecheck failure records
  a `StageResult` for typecheck with the nonzero exit and **does not run** the test stage (fail-fast).
- Backward-compat test: `Proof` without stages still serializes/deserializes; existing proof consumers
  unaffected.
- Live: run the pre-land gate on a repo with a failing typecheck; confirm the recorded proof shows the
  typecheck stage red and the reason names it.

## Resolution
Shipped. `detectVerifyStages` (src/intake.ts) returns the ordered named stage list; `detectVerify` is
now its `&&`-join (one source of truth — existing detectVerify tests unchanged). `Proof.stages:
StageResult[]` added (src/proof.ts); `runProof` runs stages fail-fast, records per-stage receipts +
skipped markers, names the failing stage in `detail`, and keeps `command`/fingerprint = the joined
string (proof-freshness unchanged). Both `runProof` callers (src/squad-manager.ts) pass stages for
auto-detected gates; custom acceptance commands stay a single opaque stage. Verified live by tests
that spawn real commands through the real gate path (tests/proof.test.ts, tests/intake.test.ts).

