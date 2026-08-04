# The untype-checked test corpus — close the compiler blind spot
STATUS: open
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
