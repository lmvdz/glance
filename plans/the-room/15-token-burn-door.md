# Token-burn door — fleet economics from the room
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/transcript-event-kinds.ts, emit site (receipt/cost path), webapp/src/components/hub/TokenBurnCard.tsx (new), economics surface/route, tests
BLOCKED_BY: 05, 08
MODE: afk

## Goal
Fleet-wide token burn is visible from the room (Lars's stated layer-2 example): periodic/threshold
token-burn-snapshot cards (per-unit on completion; fleet rollup on threshold), door opens a fleet
economics view — per unit, per lane, per model — built on the receipt/contextPct roster data and
harness-attribution ingesters that already exist.

## Approach
1. token-burn-snapshot kind + reader together. Emit: unit terminal states (receipt totals in
   scope at settle/land) + a fleet rollup on a coarse cadence or cost-gate threshold events — NOT
   per-turn (noise; #fleet filter applies).
2. Economics door: a compact surface (route) aggregating receipts by unit/lane/model — reuse the
   existing cost/receipt data paths (AgentDTO receipt, harness attribution ingesters); no new
   accounting invented.

## Cross-Repo Side Effects
None.

## Verify
- Unit completes in scratch daemon → burn card with real receipt numbers; door shows the unit in
  a fleet table; numbers match `GET` roster receipt fields exactly (no drift).
