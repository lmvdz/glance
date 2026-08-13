# UnitAttentionLane — one raiser, one escalation ledger
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/squad-manager.ts — 10 hand-rolled attentionEvents writes (5367, 5504, 5529, 5583, 6338, 6359, 8214, 9438, 11088, 11487), 3 duplicate idempotency Sets, 3 cooldown/streak Maps, helpers 5339–5630 + 9431–9464
MODE: afk

## Goal
Highest leverage per line in the round: eight raisers re-implement append-then-emit
(inconsistently — some try/catch the emit, some don't); three Sets duplicate one dedupe job.
A five-method lane (raise/clear/escalateOnce/noteEpisode/clearEpisode, 3 deps) deletes SIX
manager fields, thins landInner by ~40 lines, and provides concern 18's raise/clear port.
Note: two unrelated AttentionEvent types exist (src/attention.ts operator lane — has a module;
types.ts per-unit DTO lane — has none; this concern gives the second its module). Never gates
anything → clean cut. Pairs with concern 26 (this is its daemon-side chokepoint).

## Provenance
Round-2 review, daemon agent, rank 2, Strong.

## Done (2026-08-11, round 3 iteration 6 — PR #374)
Shipped as designed minus one deliberate scope cut: UnitAttentionLane.raise is the one
append-then-emit chokepoint (fail-open BY CONTRACT, quiet mode for the three tail-broadcast
sites, pre-minted-id passthrough for baseline/membrane events); EscalationLedger replaces the
five Map/Set fields with episode/bump/once/clear, semantics tick-exact at the cap boundary
(both lineages verified independently). SCOPE CUT vs the original sketch: boundary-sync keeps
its own kind-keyed REPLACE rows — #371 shipped its lane with internal helpers, and replace-
freshest-wins is a different behavior from append-only raising; forcing one chokepoint over
both would be dishonest (module doc records this). Review round: grok 5/5 clean attack axes +
2 Lows (forensic wording fixed; fail-open expansion traced and adjudicated by-design); codex
1 M (randomUUID minted OUTSIDE the try — escaped the fail-open exactly where once-flags were
already armed; construction moved inside the guard) + confirms all 8 rewires field/order-exact
and zero stray attentionEvents writes remain. Gates: check 0, root 5340/2-inherited, webapp
2002/0, lane 8/8. Concern 26 gets its daemon-side chokepoint as planned.
