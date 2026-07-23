# Pre-dispatch harness scorecard (advisory shadow)
STATUS: done — merged in PR #115 (b395b89), src/harness-scorecard.ts live on main; verified on main, 2026-07-21 reality audit
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/dispatch.ts, webapp/src/lib/insights.ts
PR: https://github.com/lmvdz/glance/pull/115

## Goal
Statically score a unit's harness across the 5 subsystems (instructions/tools/environment/state/
feedback) before spawning, and surface red flags advisory-only, so context-poor units are visible at
admission instead of after a wasted run.

## Why it was DEFERRED, and why it's buildable now
Both red teams recommended deferring, for three reasons — all three are resolved:
- Its highest-value red signal — "instructions = title-only + empty primer" — was exactly what
  **concern 01 fixes**. Concern 01 (authored-spec injection) shipped, so the signal now has real
  variance instead of reporting the known-broken state on every unit.
- Two of the five signals (`environment=wt.inPlace`, `state=no workflowState`) would have been
  evaluated *before* the worktree/state exist if scored at the early hook (createWithId's old
  line ~3238) — constant false-red unless split across two hook points. **Resolved by NOT splitting**:
  this implementation scores all five dimensions from a SINGLE hook placed after the worktree cut,
  harness resolution, and `routeIntake` — every dimension has real data by then, so the two-hook split
  the original design sketched turned out to be unnecessary.
- Routing the shadow through the shared `attention` kind (insights.ts's `attentionItems`) would cause
  alert-fatigue burying real "needs-you" events. **Resolved**: `harnessScorecardFindings` is its own
  read-model function, never folded into `attentionItems`/`AttentionKind`.

## What shipped
- `src/harness-scorecard.ts` (new): pure `scoreHarness(input): HarnessScorecard` — five booleans in,
  a 0-5 score + per-dimension red flags out. Zero LLM calls, zero I/O, import-free of the rest of the
  fleet machinery (same monitor-only contract as `drift-lens.ts`, enforced structurally: this module
  can only return a plain data record, so it cannot block or mutate a spawn). `harnessScorecardEnabled()`
  (default ON — `OMP_SQUAD_HARNESS_SCORECARD=0` to silence) and `harnessScorecardLogLine()` (formats a
  one-line diagnostic, `undefined` for a clean 5/5 or an absent scorecard).
- `src/types.ts`: `AgentDTO.harnessScorecard?: HarnessScorecard` — computed, not persisted (absent from
  `PersistedAgent`, never written to `state.json`).
- `src/squad-manager.ts` (`createWithId`): stamps `dto.harnessScorecard` right after the DTO is built,
  reusing already-resolved locals (`specBlock`, a hoisted `hasPrimer`, `toolGrants`, `produces`,
  `resolvedBranch`, `opts.featureId/issue/workflowState/verify/workflow`) — no new re-derivation, no
  new I/O. `dispatchSpawn` now returns the created `AgentDTO` (was discarded) so the dispatcher can
  read it.
- `src/dispatch.ts` (`Dispatcher.tick()`): when `DispatchDeps.spawn` returns the created DTO, a
  red-flagged scorecard logs a one-line diagnostic naming the issue, right at auto-dispatch admission.
  Never affects spawn count/budget/dispatched-set; a `void`-returning spawn (existing test fakes)
  behaves byte-for-byte as before.
- `webapp/src/lib/dto.ts` + `insights.ts`: mirrored `HarnessScorecardDTO` type + `harnessScorecard`
  field on the webapp `AgentDTO`; `harnessScorecardFindings(agents)` — its own diagnostic read-model,
  worst-score-first, omitting agents with no scorecard or a clean 5/5.

## Verify
- `tests/harness-scorecard.test.ts`: pure `scoreHarness`/`harnessScorecardLogLine`/
  `harnessScorecardEnabled` tests, plus `SquadManager#create` integration tests proving each dimension's
  wiring (title-only-vs-authored-spec instructions, requires/produces tools, existingPath-vs-real-worktree
  environment, featureId/issue/workflowState state, verify/workflow feedback) — including the exact
  worked example from the original design ("a title-only + empty-primer unit scores red on instructions,
  ... a fully-provisioned unit scores 5/5") and a maximally-red (0/5) unit that still spawns successfully
  (the core "advisory, never blocking" contract).
- `tests/dispatch.test.ts`: red-flagged spawn logs a diagnostic line; clean 5/5 and void-returning spawns
  log nothing extra.
- `webapp/src/lib/insights.test.ts`: `harnessScorecardFindings` omits clean/absent scorecards, surfaces
  red-flagged ones, sorts worst-first, and never appears in `attentionItems`' output for the same agent.
- Full suite green (root `bun test` + `webapp/bun test`); root + webapp `tsc --noEmit` clean.
