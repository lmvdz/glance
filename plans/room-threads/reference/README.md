# Design reference — five rounds

Runnable HTML, not pictures. Open any file directly; each has a tab bar across the top switching
between its states. Screenshots of every state sit alongside in `shots-*/`.

| File | Round | States |
|---|---|---|
| `01-room.html` | the main screen | busy · quiet · a decision · the decision arrived too late |
| `02-surfaces.html` | what sits beneath it | 19 — answering, opened runs, standing in a unit, handover, mentions, search, starting work, handover of stalled work |
| `03-machinery.html` | what sits beneath those | 12 — reading an instruction back, widening autonomy, collisions, agent records, the archive, unanswered questions |
| `04-beyond.html` | when nobody is at the screen | 12 — the phone, stall detection, the undelegatable category, rules firing, unwinding, cost |
| `06-other-side.html` | the agents' view and the product's own failure | 10 — what an agent sees, agents negotiating, disconnection, restart, **the product wrong about itself**, leaving |
| `07-shell.html` | the frame, once the product has a voice | 7 — at rest, in flight watched, **from across the room**, permission mid-speech, talking→typing, several sessions, **sound/motion/silence** |
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


## Round six — the product wrong about itself

`06-other-side.html` → **5a** is the one to read. The product discovers it was wrong about itself for
eleven hours, and the root cause is this repository's own recurring defect stated as a product
failure: *"An agent's last message before it dies looks exactly like an agent's last message before
it finishes. We had been treating 'nothing more from Ash' as 'Ash is done' — for eleven hours nothing
checked the one thing that would have settled it, which is the table itself."*

Its fix is the epistemics model the shell round later gives a spoken form: three claim states where
the ordinary one is unmarked — **checked** (we asked the thing itself), **on an agent's word**,
**cannot be verified right now** (with what would settle it and when it will retry). "Only the last
two are ever marked," so honesty never becomes a screen full of caveats.

## The shell round — two findings that change implementation

**Motion is the state channel, and it is the only animation in the product.** A four-pixel strip on
the top edge carries six states in movement rather than colour — "colour is the first thing
peripheral vision loses and the first thing a colour-blind reader never had; movement is the last."
Only three of the six move and nothing else animates, so motion in the corner of the eye is
unambiguous. Live microphone is the only state that *breathes* at a human rate, because talking into
a dead mic is the expensive mistake. Stopped-without-anyone-deciding is *stiller and darker* than at
rest. `07-shell.html` → 3.

**Uncertainty lives in grammar, not in disclaimers.** `07-shell.html` → 7 gives round six's three
claim states a spoken form:

| form | shape | example |
|---|---|---|
| verified | past tense, evidence in the same breath, no attribution | "The lookup is 40 milliseconds now. I have the timing." |
| second-hand | the source is the subject | "Wren says the missing index is the cause." |
| unverifiable | who thinks what, then what would settle it | "…so I can't tell you whether it worked. Wren thinks it did." |
| a step | present participle, agent as subject, never an adjective about the thing examined | "She's timing the session lookup against staging." |

Only the first is allowed to sound settled, and it is the ordinary one. A step describes a person
acting, not a system being well. It survives a half-listening reader because it is already how people
report second-hand information.

**The governing rule: the product may never speak an outcome it did not receive as an outcome.** It
may narrate steps and may say it does not know; it may not summarise a stream of steps into a
conclusion. That is the line between a claim and a belief.

Four sounds exist in the entire product — a stop tone for permission (twice a month), the microphone
opening and closing under the user's own hand, and nothing at all for the other 99%. Silence is
specified as a medium with its own budget: "Sixty-one steps produced four screen lines and no sound."
