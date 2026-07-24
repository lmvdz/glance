# Unit lifecycle cards — the room needs the facts a human actually watches for

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/transcript-event-kinds.ts, src/squad-manager.ts (spawn/turn/PR emit sites), webapp/src/lib/channelTimeline.ts, webapp/src/components/hub/*, tests
BLOCKED_BY: 26
MODE: afk

## Goal
The room tells you what your fleet is doing, on the paths the fleet actually takes.

## Why this exists
Concern 26 removed the noise (544 tool-approval cards, 100% of #fleet). What it exposed is the other
half of the same defect: **in twelve hours of real fleet work, not one signal card fired.** Zero
gate-verdict, zero land-attempt/assessment/merge, zero plan-card, zero token-burn.

Not because those readers are broken — 13/14/15/16 built them correctly and they render well against
seeded data. Because their emit sites sit on the *land* and *gate* flows, and this fleet's actual
work lands through hand-driven merge trains (one train per wave — the landing policy adopted after
the wave-0 flake roulette). The kinds were chosen from the trust layer's vocabulary, which is the
right vocabulary for *proofs*, and then nothing was chosen for the vocabulary of *ordinary progress*.

So a human watching the room sees nothing happen for hours while four units work. The room is not
wrong; it is silent about everything except two rare events. Silence is what a dashboard-shaped
product was supposed to fix.

## Approach
1. Name the missing facts — the ones a human refreshes a terminal to check today:
   - **unit spawned** (who, what task, which repo/branch, which channel)
   - **turn finished** (unit went working → idle, with the one-line summary it produced)
   - **unit failed / errored** (with the error class, not the stack)
   - **PR opened** (number + URL — the single most-watched fact in this repo's workflow)
   - **verification ran** (suite green/red with counts — the fleet's most common self-check)
   Each ships with its reader in the same landing unit (the standing "no kind lands before its
   reader" rule).
2. Apply concern 26's worthiness discipline from the start: these are *state transitions*, not
   prompts, so they are naturally low-volume — but pin the expected volume per unit-hour in the test
   so a future emitter cannot turn one of them into the next firehose. A card kind whose rate is not
   bounded by a state machine does not ship.
3. Fold the existing `transitions` JsonlLog (already the daemon's state-transition record) in as the
   emit source rather than adding new call sites scattered through squad-manager — one substrate,
   the same relation the design draws between room cards and the attention lane.
4. Density: with these kinds live, #fleet gets busy again for the right reasons. Group consecutive
   same-unit lifecycle cards into one collapsible run in the timeline (the fold TranscriptTimeline
   already does for tool calls) before this lands, not after.

## Cross-Repo Side Effects
None.

## Verify
- Scratch daemon, four units through a full spawn → work → verify → PR cycle: the room narrates the
  run without a human opening a terminal, and a reader can answer "what happened while I was away?"
  from the timeline alone.
- Volume test: a unit-hour of ordinary work produces a bounded, asserted number of cards.
- The love gate (concern 23) runs against this, not against the seeded fixture.

## Notes
Filed 2026-07-24 from the same live boot that produced concern 26. Deliberately NOT widened into 26:
that concern removes noise and is safe to land immediately; this one adds emitters and needs its own
review of what a card costs in attention.
