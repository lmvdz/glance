# Memory lane directory + seam — src/memory/ with index.ts as the interface
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/memory/* (13 moved files), src/memory/index.ts, tests/memory-lane-boundary.test.ts, CONTEXT.md
MODE: afk

## Goal
The 13 memory-lane files stop being flat-src peers: `src/memory/` with a curated `index.ts`
interface, outside deep-importers frozen by a set-diff allowlist test (ratchet-down twin included).

## Done
PR #310 commit 59455b94. Move was purely mechanical (NUL-safe rewrite script); check green,
lane tests 233/0. Follow-up lives in the allowlist: migrate the ~36 pinned deep importers to the
barrel module-by-module, shrinking ALLOWED as you go.
