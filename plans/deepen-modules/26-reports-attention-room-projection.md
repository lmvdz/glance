# Room projection for reports / attentionEvents
STATUS: needs-lars
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural (~350–450 lines, mostly patterned)
TOUCHES: src/squad-manager.ts (10 write sites → concern 19's chokepoint), projection-classes.ts, schema/channel-card.ts, transcript-event-kinds.ts (needs PR #317), webapp channelTimeline registry + card actions
MODE: afk — WITH ONE PRODUCT GATE FOR LARS (below)

## Goal
The gap named by concern 17: squad_report proposals and attention events (boundary-sync
held-with-Apply, divergence-with-Acknowledge) are write-only. The machinery exists end-to-end
(projection classes, needsYouFace as template, card schemas, compile-forced registry). Shape:
TWO NEW KINDS — report-raised (register: claim — a self-report is not a proof) and attention
(tone by sync class) — NEVER folded into needs-you (its projection class means "work has
stopped"; these are explicitly non-blocking). Must adopt the replay-suppression discipline
emitNeedsYouProjection documents (the "announced thirteen times" bug). Action-bearing cards
(Apply/Discard/Acknowledge) are the one genuinely new mechanism.

PRODUCT GATE (needs Lars, recorded here, does not block the daemon-side chokepoint work which
is concern 19): does a non-blocking proposal earn a room card at all? DIRECTION.md's human
contract says an over-populated needs-you lane is itself a bug — the design must ration.

## needs-lars (2026-08-11, round 3 iteration 10)
THE OPEN QUESTION (product gate, verbatim from the Goal): does a non-blocking proposal earn a
room card at all? DIRECTION.md's human contract says an over-populated needs-you lane is itself
a bug — the design must ration. Everything still open in this concern IS the gated surface: the
two new kinds (report-raised, attention) are precisely the cards the question asks about, so
there is no pre-gate slice left — concern 19 already shipped the daemon-side chokepoint
(UnitAttentionLane), and concern 09's registry means the moment Lars rules, each new kind is
one registry entry + one schema entry + one emit site through the lane. If the ruling is NO
(ration harder), the honest alternative recorded here: reports/attentionEvents surface only
through the unit drawer (already rendered) + the weekly episode digest, never the room timeline.

## Provenance
Round-2 review, webapp agent, rank 4, Worth exploring. Pre-named by concern 17's codex HIGH.
