# UnitAttentionLane — one raiser, one escalation ledger
STATUS: open
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
