# Loops emit skip reasons on no-op ticks

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/scout.ts, src/opportunity.ts, src/orchestrator.ts, src/dispatch.ts
PLANE: OMPSQ-341 — https://app.plane.so/inkwell-finance/browse/OMPSQ-341/

## Goal
Every loop, on a tick where it intentionally does nothing, emits a `recordSkip` event
naming why — so the ledger proves the loop is alive and the digest (concern 02) can
classify it. (Observer's gate-skip is handled separately in concern 04, since it lives
in `runMainGate`.)

## Approach
Wire `recordSkip` (from concern 01) into each loop's existing short-circuit / no-op
paths. **Keying is load-bearing**: per-repo loops MUST pass `repo` so two repos'
skips don't clobber each other (red team A-C2). Per-repo recorders are already bound
as `automation.for("observer", repo)` etc. (`squad-manager.ts:648,674,693`); fleet-wide
loops (`automation.for("dispatch")`, `:612`) pass no repo.

- **Scout** (`src/scout.ts`): the two existing early returns already are skips —
  `if (!live.length) return;` (`:298`) → `recordSkip({ skipReason: "no live reasoning" })`;
  budget exhausted (`:319`) already records a `warn` — augment it with
  `skipReason: "scout budget exhausted"` so the digest reads it as idle-by-policy, not
  an error.

- **Opportunity** (`src/opportunity.ts:134`): it re-clusters every tick and often
  finds nothing. On a tick where `found === 0 && filed === 0`, emit
  `recordSkip({ skipReason: "no new opportunity clusters", repo })` instead of (or in
  addition to) silently returning. (Concern 04 does NOT gate this loop — clustering is
  cheap; we only need the liveness/skip signal here.)

- **Orchestrator** (`src/orchestrator.ts:170`): fleet-wide. When a tick processed no
  agent that had work (the per-agent `agentHasWork`/`agentHasUnlandedWork` gate at
  `:196` already short-circuits idle agents), and nothing was landed/healed, emit
  `recordSkip({ skipReason: "no agent had unlanded work" })`. Note this loop is the
  existing reference for change-gating — we are only adding observability, not gating.

- **Dispatch** (`src/dispatch.ts:179`): fleet-wide. On a tick with no ready issue
  (all deferred/blocked or at WIP cap), emit `recordSkip({ skipReason: "<at WIP cap | no
  ready issues | all blocked>" })`. Reuse the reason it already logs at `:148-151`.

Keep these cheap — `recordSkip` is a synchronous ring push + at-most-one spool on
transition. Do not emit a skip on ticks that DID do work (those already record
meaningful events).

## Cross-Repo Side Effects
Depends on concern 01 (`recordSkip` + field). Touches `src/dispatch.ts` and
`src/orchestrator.ts`, which concerns 09 and 04 respectively also touch — see overview
for ordering (this concern lands first; 04/09 build on the same files afterward).

## Verify
- `bun run typecheck` clean.
- Run the daemon idle (no live agents): within ~2 minutes the automation log shows one
  skip-transition row per loop with a sensible reason; subsequent idle ticks do NOT
  spam the JSONL (transition-spool from concern 01).
- `bun test` (the 2 spawn tests need `node_modules/.bin` on PATH per repo memory).
