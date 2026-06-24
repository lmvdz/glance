# Verification + parity checklist + docs
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/**/*.test.ts, README.md

## Goal
One runnable check on each piece of pure logic, a parity sweep against `src/web/index.html`, and docs.

## Approach
- **Unit tests** (`bun test` in `webapp/`, no framework beyond it): inbox fold + oldest-first sort;
  transcript reducer (append/dedupe by agent); `AnswerControls` value mapping per `kind`; palette
  fuzzy matcher. Pure functions extracted from the components for testability.
- **Parity sweep** — walk the `00-overview.md` matrix against a live daemon (`OMP_SQUAD_WEBAPP=1`,
  agents `--approval always-ask`): roster, transcript, every approval kind, prompt/interrupt/kill/
  restart/remove, land/diff/subagents, spawn, board, audit, palette. Tick each row.
- **Docs** — README: the new dashboard, the parity status, and what's deferred (P3:
  federation/presence/leases/deep-Plane). Note it still lives behind `OMP_SQUAD_WEBAPP=1`.

## Cross-Repo Side Effects
None.

## Verify
- `cd webapp && bun run test` green; root `bun run check && bun test` green (incl. `tests/webapp.test.ts`).
- Every parity-matrix P1/P2 row is checked off; deferred rows are documented.
