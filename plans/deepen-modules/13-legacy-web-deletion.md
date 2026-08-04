# Deletion test on the legacy src/web UI
STATUS: open
PRIORITY: p3
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/web/ (2,623-line opt-in legacy inline-HTML UI), its compat branches in src/server.ts
MODE: needs-lars

## Goal
The legacy fallback UI holds compat branches open in server.ts while React webapp/ is the live UI
(GLANCE_WEBAPP=1 — see the UI-split memory). Deleting it removes complexity rather than moving it
— the rare candidate where the deletion test passes by deletion. Retiring a shipped surface is
Lars's call; this concern exists so the question gets asked once, with the inventory attached,
instead of the compat branches accreting forever.

## Provenance
Whole-repo report candidate 8 (Speculative, flagged as operator-decision).
