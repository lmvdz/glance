# What the designs specify, and what the app actually shows

Measured 2026-07-26 by extracting every named zone from the seven reference files and checking each
against `webapp/src`. Not an impression — a count.

## The number

**About 10 of 123 designed zones exist in the app.** Roughly 8%.

| Reference | Zones | In the app |
|---|---|---|
| `01-room.html` | 12 | 5 |
| `02-surfaces.html` | 34 | 3 |
| `03-machinery.html` | 24 | 0 |
| `04-beyond.html` | 18 | 0 |
| `05-first-week.html` | 15 | 0 |
| `06-other-side.html` | 17 | 0 |
| `07-shell.html` | 3 | 0 |

## What this actually means

The gap is not evenly spread, and its shape is the finding.

**Concerns 11–21 are built and none of them are visible.** Autonomy rules, the delegation boundary,
plan motion, instruction readback, the notification gate, cold start, retention, agent records, human
authority, plan proposals, decision impact — every one has a module, a store, a manager seam and tests.
Not one has a surface. `03-machinery`, `04-beyond` and `05-first-week` are almost entirely the design
FOR those concerns, and they score zero.

So the plan built the record and skipped the reading of it. A person cannot see the rule that settled
their work, the unknowns ledger, the stall watcher, what a decision cost, or what an agent's record
actually says — all of which exist as data today.

That is the same failure as the first attempt at concern 03, one level up: the rules were implemented
and the form was not.

## The three that matter most

1. **`03-machinery` — rules and boundaries have no face.** Concern 11 stores the human's sentence and
   concern 12 refuses on it, and neither is quotable on screen. "WHAT THE FLEET MAY SETTLE TODAY" and
   "THE ONE SHE WILL NOT DO ALONE" are the surfaces that make autonomy legible; without them the fleet
   is exactly as opaque as before the work.
2. **`02-surfaces` — the decision screen.** 34 zones, 3 present. "ANSWER IN WORDS", "WHAT SHE ALREADY
   WORKED OUT", "WHAT WREN WILL TAKE FROM THAT" are the core interaction of the product — a person
   answering a stopped agent — and it does not exist. The alarm band shows the questions; nothing
   answers them in place.
3. **`04-beyond` — cost and unwind.** Concern 21 computes reversal cost, nearest repair, spend versus
   waste, and the disclosure rule. "WHAT CHANGES IF YOU TAKE IT BACK" and "WHEN COST IS ALLOWED TO
   SPEAK" have no rendering, so the rule about where cost may appear is enforced against nothing.

## What IS present

The room frame and its top bar, the alarm band, "WHERE YOU ARE STANDING", the handover on a quiet
room, the folded run's verdict, the addressability note, and the message and card treatment. That is
`01-room`'s busy and quiet screens, most of the way.

## What this audit is for

Not a backlog. It is the answer to "does what we designed show itself in the app", and the answer is
no — the plan reached 21/21 concerns done while showing under a tenth of the designed surface. The
concern files were honest about their own scope and still added up to something that is mostly
invisible, because almost every concern's Verify list checks a record and not a rendering.

**The correction that follows from it:** a concern is not done when its data is right. It is done when
a person can see it. Any future concern in this plan should carry a Verify item naming the zone in the
reference it makes visible — and if it names none, that is worth noticing before the work starts
rather than after.
