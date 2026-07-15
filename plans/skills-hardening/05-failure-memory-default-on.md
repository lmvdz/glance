# Flip OMP_SQUAD_FAILURE_MEMORY default on + imperative rendering
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts, src/observer.ts, src/fabric-search.ts, tests/
BLOCKED_BY: 04

## Goal
The built-and-wired failure-memory→primer path actually transports lessons: recurring-failure annotations flow into every unit's context primer by default, rendered as imperatives.

## Approach
Red team finding F8: the mechanism exists end-to-end (src/failure-memory.ts → fabric.ts:206-219 → fabric-search.ts:111-115 "Recurring failure" docs → buildContextPrimer → primeContext reaches every spawn) but `OMP_SQUAD_FAILURE_MEMORY` defaults OFF on both write (observer.ts:101) and read (squad-manager.ts:3285) sides — a parallel static list around a disabled mechanism was scope-shaped reasoning; this concern flips it.

1. Default the flag on (write + read sides); keep the env var as the off-switch.
2. Rendering tweak in fabric-search.ts: prefix recurring-failure primer lines with "Do not repeat:" so injected text reads as an imperative, not a description (content stays inside the primer's untrusted fence).
3. Measurement: the flag is already a `Variant` (metrics.ts:43,80) — record before/after via existing metrics; watch primer size (topK=6 already bounds it) and spawn-path latency (primer has 5s timeout + circuit breaker already).
4. Update any tests asserting the old default.

BLOCKED_BY 04 because both touch squad-manager.ts's spawn path (shared-file rule), and 04's static block is the fallback narrative if this flip has to be reverted.

## Cross-Repo Side Effects
None. Blast radius = primer content for every spawn; trivially reversible via env var.

## Verify
Unit tests for both defaults; live scratch-daemon run: seed a failure annotation (`<stateDir>/failure-annotations.json`), spawn a unit with a matching task query, confirm the primer contains "Do not repeat: <rootCause>"; confirm a unit spawn with the env var set to 0 omits it; check Variant metrics record the arm.
