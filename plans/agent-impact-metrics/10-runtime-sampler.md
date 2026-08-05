# Runtime execution sampler (realized-line rate)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
BLOCKED_BY: 05, 07
TOUCHES: src/impact/sampler.ts (new), src/impact/snapshot.ts, daemon entry wiring (TBD by research)

## Goal
The deferred execution axis: fraction of a unit's added lines actually executed by the dogfooded daemon within N days — upgrading "statically referenced" to "realized".

## Approach
Research-first (this is greenfield; nothing existing to piggyback on — spans.ts is agent-run granularity by design and must not be extended for this):
- Evaluate Bun/V8 coverage seams for a long-lived process: periodic `NODE_V8_COVERAGE`-style dumps, inspector-protocol `Profiler.takePreciseCoverage` sampling windows, cost of enabling on the live daemon. Production/dogfood truth only — gate/test coverage must never feed this metric (tests execute dead features; that is the lie this axis exists to remove).
- Map covered function/line offsets back through addedRanges; write an `executed` block into existing snapshot files (schema-versioned addition).
- Only after this lands may any surface use execution words; until then concern 08's labels stay reference-only.

## Cross-Repo Side Effects
None.

## Verify
A seeded scratch-daemon run: land a unit with one hot path and one dead path; sampler distinguishes them; overhead measured and documented before any always-on default.
