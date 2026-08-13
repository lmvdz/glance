# The untype-checked test corpus — close the compiler blind spot
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical (bounded, measured)
TOUCHES: webapp/tsconfig.json (excludes 116 test files / 21,443 lines), root tsconfig (tests/ never included: 436 files / 92,453 lines), package.json check script
MODE: afk

## Goal
Discovered adjudicating concern 17: webapp tests are type-checked NOWHERE (bun elides unused
imports — a deleted-module import passed every gate). MEASURED breakage: webapp 77 errors in
24 files (ZERO production files affected — classes: fixtures missing ranAt on the one
conformance-guarded DTO, stale casts, assertions on deleted fields); root corpus 283 errors in
119 files. Gate: tsconfig.tests.json each side (types:["bun"] REQUIRED — verified) as clauses
3+4 of bun run check. TWO LANDS: webapp first (bounded), root second (the slog). This is the
enabling gate for concerns 24, 26, 27.

## Provenance
Round-2 review, webapp agent, rank 1, Strong. Pre-named by the concern-17 round (native
blind-spot ledger row).

## Done (2026-08-11, round 3 iterations 3-4 — PR #372)
Both lands shipped. Webapp: tsconfig.tests.json = check clause 3, 75 errors/24 files paid to
zero (plus grok's side-door: webapp's own typecheck/build scripts now run the tests program
too). Root: tsconfig.tests.json = clause 4, 301 errors/~120 files paid to zero by four parallel
fixers under a written playbook (iron rule: never change what a test asserts); codex audited all
48 changed expect-pairs and 60+ hunks, grok verified renames against production unions. One
production fix (OrchestratorDeps.land — widened on a bucket flag, then REVERTED when codex
proved the only adapter is boolean and the test fake never reached tryLand; the cross-lineage
disagreement is ledgered). Review yield: 9 adjudicated rows across both slices — wire-faithful
fixtures (voice bindings, voice-fleet-action), the named-headline contract now actually proven
with an unnamed control, Archil exercised on the interface shape.
FOLLOW-UPS (drift-risk, not defects): export server.ts's SocketData (fanout test carries a
structural mirror) and squad-manager's needsYouFace face shape (projection test's local guard
drifted once already). Enables concerns 24/26/27 as designed.
