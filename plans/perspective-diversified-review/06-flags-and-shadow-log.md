# Flags, default-off contract, and shadow catch-logging
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/config.ts, src/validator.ts, src/validator.flags.test.ts

## Goal

The rollout surface: every flag the feature reads, a test proving the whole feature stays dark by
default, and a shadow log that makes the feature's value **measurable** — so the deferred pool is
gated on evidence, not belief.

## Approach

In `src/config.ts`, add helpers mirroring the existing `OMP_SQUAD_VALIDATOR_HARNESS` pattern:

- `OMP_SQUAD_LENS_REVIEW` — master, boolean, default **off**. Gates all lens work.
- `OMP_SQUAD_LENS_SET` — CSV allowlist of `LensId`s (debug override for `selectLenses`).
- `OMP_SQUAD_LENS_MAX` — integer, default **1** for v1.
- `OMP_SQUAD_LENS_TIMEOUT_MS` — integer, default **60000** (< criteria judge's 120s).
- `OMP_SQUAD_LENS_VERIFY` — boolean, default off; only meaningful inside an enabled panel
  (concern 05).

Wire the master-flag read at the single `validatorGate` entry point from concern 03 (the check
that skips all lens work). Use the existing env-parse helpers (guard against the
`Number(env) || default` zero-eating bug the Effect-schema work fixed across 34 sites — a `0` cap
must mean zero, not fall back to 1).

**Shadow catch-logging.** When a lens fires, log a structured line (reuse the existing structured
logger) capturing: `lensId`, `disposition`, `severity`, `claim`, `verifyConfirmed?`, the unit id,
the criteria verdict it rode alongside, and whether the criteria judge itself would have caught it
(i.e. was this genuinely out-of-criteria). This is the dataset that answers RT2's premise attack —
"does a focused lens catch what the monolithic judge missed?" — before any pool is built. Surface
per-land lens spend through the existing harness attribution ledger so cost is visible.

## Cross-Repo Side Effects

None — flags are read where the feature already lives. The shadow log is additive.

## Verify

- `src/validator.flags.test.ts`: **master flag off ⇒ zero lens/verify `decideTyped` calls** on a
  risky diff that would otherwise fire (assert against a spy on the lens judge). This is the
  load-bearing default-off contract test.
- `OMP_SQUAD_LENS_MAX=0` ⇒ zero lens calls even with the master flag on.
- `OMP_SQUAD_LENS_MAX=1` + risky diff + master on ⇒ exactly one lens call, and a shadow log line
  is emitted.
- `bun test` green; full backend suite green; `tsc` clean.

## Notes — the evidence gate

Do not build the deferred multi-lens pool (perf/architecture/testing) or the criteria-injection
promotion path until the shadow log shows the `regression` lens catching real defects the criteria
judge missed over a meaningful sample of live lands. v1 is the experiment; this log is its readout.
