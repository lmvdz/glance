# Learning-loop metrics + flag scaffolding
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/metrics.ts, src/workflow/engine.ts, src/observer.ts, src/proof.ts, src/server.ts, tests/metrics.test.ts

## Goal

Establish the baseline the rest of the plan is measured against, and the flag pattern each concept ships behind. After this concern, an operator can read — from existing exhaust, no new deps — the five metrics that tell whether the learning loop helps, and can toggle each later concept independently for A/B comparison.

## Approach

Five metrics, all computable from signals that already exist:

- **first-try-green rate** — fraction of verify-workflow runs where `verify` passes with **zero** fixup visits. The workflow engine already tracks per-node visit counts; expose `fixupVisits` on the run outcome and pair with `proof.ok`.
- **fixups-to-green** — distribution (count + mean/median) of fixup visits consumed before `verify` passes.
- **escalation rate** — fraction of runs reaching the `escalate` node.
- **land-failure-streak frequency** — how often `observer.ts` fires its `≥3` land-failure finding (add a counter where the streak finding is emitted).
- **primer-empty rate** — fraction of cold-starts where `buildContextPrimer` returns `""` (instrument at the call site; the fabric-search change in 02 will expose the empty case).

Implementation:
- New `src/metrics.ts`: a small in-memory ring + append-only spool mirroring `automation-log.ts` (do NOT invent a new persistence pattern). One `recordMetric(name, value, tags)` entry point; tags carry `{flag: "reflexion"|"reward-boost"|..., variant: "on"|"off"}` for A/B.
- Instrument the workflow engine (`src/workflow/engine.ts`) to emit run-outcome metrics (first-try-green, fixup count, escalation) once per run.
- Instrument `src/observer.ts` streak emission and the primer call site.
- `src/proof.ts`: expose a read-only helper the metrics need (e.g. `isFresh` is already exported) — do not change gate behaviour.
- `src/server.ts`: add `GET /api/metrics/learning-loop` returning current rollups per flag/variant (mirror the `/api/automation` shape).

Flag pattern (used by 03/04/05): a single `learningFlags()` reader in `src/metrics.ts` (or a tiny `src/flags.ts`) that resolves `OMP_SQUAD_REFLEXION`, `OMP_SQUAD_REWARD_BOOST`, `OMP_SQUAD_FAILURE_MEMORY` to on/off, defaulting **off**. A/B mode (`=ab`) hashes the agent/branch id to a stable variant so half the fleet runs each arm.

## Cross-Repo Side Effects

None. Optionally the webapp can render `/api/metrics/learning-loop` later; not required here.

## Verify

- `bun test tests/metrics.test.ts` — recordMetric ring/spool, first-try-green derivation from (proof.ok, fixupVisits), A/B variant is stable per id.
- `bun run check`
- Manual: run a verify-workflow to green with 0 and with ≥1 fixups; confirm the metric distinguishes them and `/api/metrics/learning-loop` reflects it.
