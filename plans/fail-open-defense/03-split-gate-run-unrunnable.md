# `gateRunUnrunnable`'s three-way `undefined`
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/gate-runner.ts, src/land.ts, src/convergence-run.ts, tests/

## Goal
`gateRunUnrunnable` returns `undefined` to mean three different things. Any future fold that maps
`undefined → allow` silently converts a real red into a merge. Split the return before concern 04
touches it.

## Approach
Per red team A (verified at gate-runner.ts:359-367), `undefined` currently means:
1. line ~360 — a genuine green: allow.
2. line ~362 — "tests demonstrably ran; this is a real red, judged on its failures elsewhere" — **not
   an allow**; the caller blocks via a different path.
3. line ~366 — no diagnosis available.

Return a discriminated result instead: `{kind:"green"} | {kind:"red-judged-elsewhere"} |
{kind:"unrunnable", reason} | {kind:"undiagnosed", reason}`. Update the 5 call sites (land.ts ×4,
convergence-run ×1) to branch explicitly. Do NOT change any call site's *behavior* in this concern —
this is a pure disambiguation; each existing branch keeps doing exactly what it does today. Behavior
changes, if any, belong to concern 04 and must be argued separately.

## Cross-Repo Side Effects
None.

## Verify
Characterization tests first: pin today's behavior at all 5 call sites (a green allows; a real red
blocks via the failure-set path; an unrunnable refuses retryably). The diff must be provably
behavior-preserving — the tests pass before and after.
