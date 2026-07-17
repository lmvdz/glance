# Flip OMP_SQUAD_FAILURE_MEMORY default on + imperative rendering
STATUS: done
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

## Resolution

Commit `462234b` — "feat(fabric): failure-memory on by default + imperative primer rendering (05)".

**Architecture differed from the concern doc's assumption.** The doc names two independent
default sites (`observer.ts:101`, `squad-manager.ts:3285`). In the actual code neither of those
is a default site — they're *consultation* sites (a JSDoc comment and an `isOn(learningFlags().failureMemory)`
read, respectively). The real default lives in exactly ONE place: `resolveVariant()` in
`src/metrics.ts`, shared by all six `OMP_SQUAD_*` learning-loop flags (reflexion, rewardBoost,
failureMemory, modelOutcomes, thresholdTuner, decisionCapture) via `learningFlags()`. Flipping
`resolveVariant`'s hardcoded `"off"` fallback would have flipped every flag's default at once,
not just failureMemory's. Adapted per the concern doc's own escape hatch ("if the flag
architecture differs... flip the SINGLE source of truth"):

- Added `FLAG_DEFAULT: Record<keyof LearningFlags, Variant>` (`src/metrics.ts:69-80`, new) as the
  single per-flag default map — every entry `"off"` except `failureMemory: "on"`. This is now
  the one line to touch to flip any flag's default in the future.
- `resolveVariant(envVar, id, defaultVariant)` (`src/metrics.ts:82-88`) takes the default as a
  parameter instead of hardcoding `"off"`; explicit `"1"` always → on, explicit `"0"` always →
  off (new — previously "0" and unset were indistinguishable, both falling through to the
  hardcoded off), `"ab"` → stable hash variant, anything else (including unset) → the flag's
  `FLAG_DEFAULT` entry. This mirrors `envBool()`'s "0"/"1"-explicit / else-fallback idiom in
  `src/config.ts`.
- `learningFlags()` (`src/metrics.ts:93-102`) now threads each flag's `FLAG_DEFAULT` entry through
  `resolveVariant`.

**Every consultation site flipped by construction** (all read through the single
`learningFlags()`/`resolveVariant` path, so no per-site edits were needed beyond updating stale
comments):
- `src/fabric-search.ts:111` (`fabricDocuments`) — the fabric read gate the concern doc named
  (`fabric-search.ts:111-115`); comment at `:108-110` updated to describe the new default.
- `src/squad-manager.ts:3288` (`annotateRecurringFailure`, the write side) — comment at `:3285`
  updated ("default off" → "default on... `=0` is the explicit off-switch").
- `src/observer.ts:101` — this is a JSDoc comment on the `annotateFailure` dep, not a flag read
  (observer.ts never calls `learningFlags()` itself; the gate lives in squad-manager's
  `annotateRecurringFailure`, which the observer calls through the `annotateFailure` hook only
  when a land-failure streak fires). Comment updated to stop asserting a stale default and to
  clarify the flag lives one level down.
- No other call site of `learningFlags().failureMemory` or `FLAG_ENV.failureMemory` exists in
  `src/` (verified via `grep -rn` across `src/`).

**Rendering tweak**: `buildContextPrimer` (`src/fabric-search.ts:237-256`) now prefixes a
`type: "failure"` hit's body with `"Do not repeat: "` before the existing 200-char trim, placed
outside the `trim()` call so the imperative itself is never truncated away on a long
title+snippet. `PRIMER_LABEL["failure"]` ("Recurring failure") is untouched — only the body
text changes — and the whole line still renders inside the same `fenceUntrusted` call as before
(no fencing change).

**Tests updated**: `tests/metrics.test.ts` (`learningFlags` describe block) — default-every-flag-off
assertion split so `failureMemory` asserts `"on"`; added an explicit `"0"`-disables case; the
"unrecognized value falls back to off" case now shows the per-flag fallback (`reflexion` → off,
`failureMemory` → on) instead of a single global off. `tests/fabric-search.test.ts`
(`recurring-failure memory` describe block) — default-unset case now asserts the failure doc
surfaces AND the primer body carries `"Do not repeat: Recurring failure · squad/a1"`; added an
explicit `=1` case (same behavior as default) and an explicit `=0` case (failure doc absent, no
`"Do not repeat"` in the primer); added a case proving non-failure hit types never get the
imperative prefix.

**Metrics/Variant check**: `learningFlags(rec.dto.id).reflexion` is the only `Variant` tag
currently recorded into `LearningMetrics` (`squad-manager.ts:3271`, the reflexion A/B tag);
`failureMemory` is read but not itself recorded as a metrics tag anywhere in `src/`, so flipping
its default changes no metrics schema or existing assertion — confirmed via
`grep -rn "failureMemory" src/ tests/` (only the sites listed above). `tests/metrics.test.ts`
needed no Variant-recording-specific update beyond the default-value assertions already covered.

**Verification run**: `bun run check` (tsc --noEmit, both root and webapp) exit 0. Targeted
`bun test` green: `tests/fabric-search.test.ts`, `tests/metrics.test.ts`, `tests/observer.test.ts`,
`tests/skills-verify.test.ts`, `tests/donot-block.test.ts`, `tests/resume-digest-surface.test.ts`,
`tests/env-example.test.ts` (which statically parses `metrics.ts`'s `FLAG_ENV` block — unaffected
by the `resolveVariant` signature change), plus the three `squad-manager-*.test.ts` files as a
non-regression sweep of the write-side caller — 138 tests total, 0 failures.

**Live-verification remaining (unit-untestable, deferred to the plan's audit phase)**: whether a
freshly-spawned unit's actual system prompt contains the "Do not repeat: <rootCause>" line
end-to-end through the real spawn path (scratch-daemon run: seed
`<stateDir>/failure-annotations.json`, spawn a unit with a matching task query, inspect the
delivered primer) and whether `OMP_SQUAD_FAILURE_MEMORY=0` observably suppresses it on a live
spawn — both are exercised only at the unit level here (`buildContextPrimer` called directly on
a synthetic snapshot), matching the concern doc's own "Verify" section split between unit tests
and a live scratch-daemon check.
