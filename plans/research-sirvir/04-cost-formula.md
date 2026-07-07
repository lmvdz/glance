# Cost-weighted selection — bounded, null-safe, tie-breaker not veto

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/smart-spawn.ts, src/attribution-scoreboard.ts

## Goal
Fold $/landed-change into model selection so a proven-cheaper model is preferred at equal quality and an expensive model must *earn* its premium — without the formula silently disabling itself or inverting the existing "escalate to opus for hard work" behavior. This is "free-lane gating" (default cheap, escalate on measured underperformance) expressed as a cost weight, not a separate feature.

## Evidence the drafted formula is broken (red-team CONFIRMED, all critical)
Drafted: `utility(m) = landRate(m,tier) − λ·costPenalty(m)`, `costPenalty = (cost(m)−cost(inc))/cost(inc)`, λ≈0.5.
- `costPerLandedChange` is real dollars (~$1–40, `attribution-scoreboard.ts:117`). The ratio is unbounded → a 3× pricier model gives penalty 2.0 → at λ=0.5 that's −1.0 on a land-rate that maxes at 1.0 ⇒ a better-but-pricier model can NEVER win. That vetoes escalation — the exact inverse of `shiftedModel`'s purpose.
- `costPerLandedChange` is `null` whenever `landed=0 || daemonRuns=0` (the common early state). The draft guards `cost(m) null` but not `cost(incumbent) null`; `x <= null` coerces to `x <= 0` (false for positive cost) then `(cost−null)/null → x/0 → Infinity` → `utility = −Infinity` → never fires. Fails closed.
- `MIN_EDGE=0.15` originally compared two land-rates (same 0..1 unit); summing a cost term of unrelated scale into the win condition makes the 0.15 threshold meaningless.

## Approach
- **Two-stage, not one blended sum.** Stage 1: rank candidates by land-rate with the EXISTING floors (`MIN_SAMPLES=8`, `MIN_EDGE=0.15`) unchanged — preserves today's semantics and the escalate-on-quality behavior. Stage 2: cost is a TIE-BREAKER only among candidates that already clear the land-rate edge (e.g. within a small epsilon of the best land-rate), preferring the lower `costPerLandedChange`. Cost never vetoes a quality win; it only decides between quality-equivalent options.
- **Bound + null-safe any cost comparison:** only compare when BOTH costs are non-null; if either is null, skip the cost tie-break (fall through to the land-rate winner). No division by a possibly-null/zero incumbent cost.
- Keep invariants: never override an explicit `plan.model`; cold incumbent ⇒ no shift; symmetric sample floors.
- Signature: prefer passing a `Scoreboard` (from `buildScoreboard`, the cost-gate.ts:45 pattern) rather than three drifting closures, so land-rate-per-(model,tier) and cost-per-model come from one source. Note the acknowledged scope mismatch (cost is per-model, land-rate is per-(model,tier)) — document it; per-tier cost is out of scope (no data).
- Make λ / the tie-break epsilon a named constant with a comment on why, not a magic 0.5.

## Cross-Repo Side Effects
Shares `smart-spawn.ts` with concern 03 — same agent or sequential. Depends on concern 02's coherent keys.

## Verify
Unit tests: (a) equal land-rate, different cost → cheaper wins; (b) higher land-rate but pricier → the better lander still wins (escalation NOT vetoed); (c) null incumbent cost → falls through to land-rate winner, never `−Infinity`; (d) all the existing `shiftedModel` invariant tests still pass unchanged.
