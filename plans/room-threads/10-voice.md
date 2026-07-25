# The voice — every string explains, not labels
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (card titles and bodies), webapp/src/lib/channelTimeline.ts, webapp/src/components/hub/*, tests
MODE: afk

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
