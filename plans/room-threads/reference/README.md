# Design reference — five rounds

Runnable HTML, not pictures. Open any file directly; each has a tab bar across the top switching
between its states. Screenshots of every state sit alongside in `shots-*/`.

| File | Round | States |
|---|---|---|
| `01-room.html` | the main screen | busy · quiet · a decision · the decision arrived too late |
| `02-surfaces.html` | what sits beneath it | 19 — answering, opened runs, standing in a unit, handover, mentions, search, starting work, handover of stalled work |
| `03-machinery.html` | what sits beneath those | 12 — reading an instruction back, widening autonomy, collisions, agent records, the archive, unanswered questions |
| `04-beyond.html` | when nobody is at the screen | 12 — the phone, stall detection, the undelegatable category, rules firing, unwinding, cost |
| `05-first-week.html` | cold start and other people | 12 — day one, two humans, the human as bottleneck, trust changing, a new agent, disagreement |

## Read these first, in this order

The design's own best statements of itself:

1. **`05-first-week.html` → 1a.** "Everything on the later screens — the stall watcher, the agent
   records, the sentence that guards your evenings — is built out of this list emptying. Nothing
   pretends to be there before it is." Day one, six borrowed defaults that declare themselves
   borrowed, and exactly one question that cannot be defaulted.
2. **`03-machinery.html` → 2a.** Autonomy is learned, never configured: "Four times this month you
   were asked whether to take the reversible option, and four times you said yes. Should the fleet
   stop asking?" Rules are stored as the human's own sentence and quoted wherever they take effect.
3. **`04-beyond.html` → 2a.** "Calm and still are not the same thing." Stall detection arriving as a
   message from the planner rather than as a monitor — the product's quiet is never traded for a
   dashboard.
4. **`02-surfaces.html` → 4b.** The weekend handover, which declares its own cut: "This genuinely
   does not fit on a screen, so it has been cut rather than compressed. What was cut is named at the
   bottom."

## The finding that matters most

**The copy is the design.** These rounds beat every earlier attempt almost entirely on their
sentences. Every string states a fact AND what it means. A string that only names a state is
unfinished work — that is concern 10, and it is p0 and architectural rather than polish, because the
strings are minted at the emit sites and by the time a card reaches the timeline the meaning has
already been thrown away.
