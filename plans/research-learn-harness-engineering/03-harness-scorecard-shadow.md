# Pre-dispatch harness scorecard (advisory shadow) — DEFERRED
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/dispatch.ts, webapp/src/lib/insights.ts

## Goal
Statically score a unit's harness across the 5 subsystems (instructions/tools/environment/state/
feedback) before spawning, and surface red flags advisory-only, so context-poor units are visible at
admission instead of after a wasted run.

## Why DEFERRED (not built this pass)
Both red teams recommended deferring:
- Its highest-value red signal — "instructions = title-only + empty primer" — is exactly what
  **concern 01 fixes**. Shipping the scorecard before 01 reports the known-broken state on every unit
  (pure noise); after 01 that signal is already handled, shrinking the scorecard's usefulness.
- Two of the five signals (`environment=wt.inPlace`, `state=no workflowState`) are evaluated *before*
  the worktree/state exist at the natural hook (createWithId:3238, worktree cut at 3381) → constant
  false-red unless the scorecard is split across two hook points.
- Routing shadow scores through the shared `attention` kind (insights.ts:511) causes alert-fatigue that
  buries real "needs-you" events — needs a threshold + a separate diagnostic channel.

## Approach (when built, after 01)
- `scoreHarness(opts: CreateAgentOptions, profile: AgentProfile|undefined, primer: string): Scorecard`.
- Split hooks: instructions/tools at squad-manager.ts:3238; environment/state after worktree cut 3381.
- Threshold-gated, off the shared attention kind (own diagnostic surface); computed, not persisted.
- Advisory only — never block dispatch (false positives would stall the fleet).

## Verify
- (Deferred.) When built: a title-only + empty-primer unit scores red on instructions *before* 01 and
  green *after* 01; a fully-provisioned unit scores 5/5; no unit is ever blocked from dispatch.
