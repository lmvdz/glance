# The voice — every string explains, not labels
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (card titles and bodies), webapp/src/lib/channelTimeline.ts, webapp/src/components/hub/*, tests
BLOCKED_BY: 11, 16, 17, 20, 21
MODE: afk

## AMENDED 2026-07-25 (RECONCILE finding 7) — the facts must exist to be spoken

This concern is necessary and was underscoped. A string lint cannot recover a fact that the event
contract never carried. The copy the design requires needs source facts not presently emitted:

- the rule's sentence, author, and date (concern 11)
- evidence age and the action staleness implies (concerns 17, 21)
- what a compaction cut, and at what fidelity (concern 17)
- a decision's consequence and blast radius (concerns 20, 21)
- uncertainty backed by a sample size (concerns 16, 18)

So this concern additionally **defines the typed proof-card payloads** those strings read from, and
ships with each new proof emitter rather than as a final copy pass over finished work. Retrofitting copy
does not work, because the meaning is discarded at the emit site.

## Built 2026-07-26

`scripts/voice.ts` + `tests/voice-ratchet.test.ts`, beside `dead-exports` and for the same reason:
this is a lint over the source, not a runtime dependency.

**Measured first.** All 12 human-facing card strings the manager emitted were label-only —
"land attempt finished · wren · ok" is true and tells a person nothing they can act on. The five that
INTERRUPT a person are rewritten and are held to the rule outright; the remaining seven are node-level
diagnostics and are ratcheted at 7, which may only fall.

Ratcheted rather than demanded all at once on purpose: a rule that requires a large rewrite before it
can land is a rule that never lands, and the point is to stop the count rising while the rest is worked
off.

The rewritten copy carries what the amendment said it needed. A merge now says what it means — "…is on
main. That has left this machine and a revert would be a new change, not an undo. Nothing else in the
fleet was touched." A needs-you says who stopped and that everything else is still moving. A gate
verdict says whether anything is waiting on you.

The lint guards itself: a scan that found nothing would pass while proving nothing, so it asserts it
found strings at all, and the rule is tested against known labels and known explanations. This is the
same fail-open the gate ratchets in this repo already guard against.

**What a lint cannot do**, which is why the amendment exists: it tests SHAPE. It cannot recover a fact
the event contract never carried. The payload contracts in `projection-classes.ts` are what make the
shape achievable, and they landed with concern 02.

## Goal
The product's copy carries as much of the design as its layout does. This concern makes that a
requirement with a test behind it, rather than a quality that decays the first time someone ships a
string in a hurry.

## Why this is p0 and not polish
The reference design ([`reference/quiet-inbox.html`](reference/quiet-inbox.html)) is better than
every earlier attempt almost entirely because of its sentences, not its boxes. Compare what this
product currently emits with what the reference emits for the same situation:

| Situation | Today | The reference |
|---|---|---|
| Three units waiting | `NEEDS YOU · 3` | "Three of these at once is a defect in the work, not a list for you to keep." |
| Nothing waiting | an empty list | "Nothing has needed you since 09:41 · 6h 12m of unbroken autonomy" |
| An agent died mid-question | `agent_exit` | "Wren waited 46 minutes, then closed her own session rather than hold a machine open. That is the rule she was given, not a crash." |
| A unit is blocked | `status: blocked` | "holding — cannot start until 3.2 is decided" |

Retrofitting voice after the fact does not work: the strings are minted at the emit sites in
`squad-manager.ts`, and by the time a card reaches the timeline the meaning has already been thrown
away. This has to land with, or before, the emitters it governs.

## Approach
1. **A string that only names a state is unfinished.** Every card title, empty state, blocked state
   and control label states a fact AND what it means for the reader.
2. **Every control says what it will do**, in a sentence beneath it. "Four files land on main. Wren
   moves straight on to 3.3 without asking again."
3. **Every interruption states its blast radius** — what is NOT affected. "44 units unaffected."
   "Nothing else in the tree depends on it."
4. **Preserved evidence carries its age** and what to do about it, because results decay.
5. **Raw identifiers are footnotes.** `agent_exit wren@3.2` belongs in a corner; the sentence carries
   the meaning. (The audit of existing leaks is concern 09; this is the rule going forward.)
6. **Folded runs carry a verdict** — a summarised run ends in a judgement ("nothing unusual"), not
   just a count.

## Cross-Repo Side Effects
None.

## Verify
- A lint or test over emitted card titles and UI strings: no string is only a status word or a bare
  identifier. Failing that check should be as loud as a type error.
- Every control in the hub has an associated consequence string; asserted, not assumed.
- Every blocked or failed state renders a blast-radius statement.
- Snapshot the four reference situations above and assert the emitted copy explains rather than labels.
