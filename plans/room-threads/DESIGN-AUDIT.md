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

---

## Re-measured, 2026-07-26 — after the rebuild pass

The same probe over the same reference now finds **26 of 123 zones**, up from 10. It undercounts:
several zones are generated at runtime (`alarmEyebrow` builds "THREE THINGS ARE WAITING ON YOU" from a
count rather than storing that string), so the literal-match probe cannot see them. Treat 26 as a
floor and 10 → 26 as the honest direction.

| screen | before | now |
|---|---|---|
| `01-room` | 4/12 | 6/12 |
| `02-surfaces` | 5/34 | 10/34 |
| `03-machinery` | 3/24 | 3/24 |
| `04-beyond` | 0/18 | 2/18 |
| `05-first-week` | 2/15 | 2/15 |
| `06-other-side` | 1/17 | 3/17 |
| `07-shell` | 0/3 | 0/3 |

### What was built, and what it replaced

- **Cost** (`04-beyond`) — spend and waste counted separately, waste only where a cause can be named,
  an unpriced run reported as unpriced rather than free. Replaced three tables of Key / Runs / Units /
  Tokens / Cost / Tools.
- **A verdict** (`02-surfaces`) — the judgement as a sentence, failures first, quiet passes named so a
  reader can tell them from checks that never ran. Replaced a chip that rendered `unknown` when nothing
  had been pinned.
- **The agent record** (`03-machinery`) — the refusal to judge comes before the claims, and a sample
  too small to carry a rate says so. Replaced a card that showed the same facts with no framing.
- **Plan vs reality** (`01-room` + `06-other-side`) — the gap is the headline, stale is never folded
  into proven, `reachable: null` is neither yes nor no. Replaced two progress rings.
- **A plan** (`02-surfaces`) — NOTHING HAS STARTED is derived rather than printed, parallelism is
  counted, out-of-scope sits beside the plan. Replaced an amber gradient with four metric tiles.
- **WHERE THIS SITS** (`02-surfaces`) — above / beneath / beside, with a leaf saying why it is a leaf.
- **WHAT GOT DONE WHILE YOU DIDN'T LOOK** (`01-room`) — the room's own account instead of a card
  floating in an empty column.
- **One shell** — every opened surface keeps the room's bar and `esc goes back to the room`, wired.

### Deleted, ~3,500 lines

`WorkspaceCockpit`, `IntervenceView`, `FleetEconomicsView`, `ChannelRail`, `GateVerdictProofView`,
`PlanBriefView`, `PlanRealityView`, `AssistantChat` (mounted nowhere), plus `diff-order.ts` and
`deriveIntervenePageContext`. Every old URL still resolves: `/intervene/<id>` and `/agent/<id>` open
the unit's own room, `/workbench/fleet` and any unrecognised workbench view open the room.

### Still old

`TaskDetail` (2,132), `DesignReviewView` (871), `OrgSettings` (520), `TaskListView` (413),
`OmpGraphPanel` (302), `DailyPanel` (298), `CapabilityPanel` (176), `FogView` (150). All reachable
only through the command palette now — no standing door leads to any of them. `TaskDetail` and
`DesignReviewView` carry real capability the designs do specify (line-level annotation is
`06-other-side`'s "WHAT HAPPENED TO WHAT YOU WROTE"), so they need rebuilding rather than deleting.

`SpawnConfirmSheet` and `SpawnStatusCard` are orphaned but kept deliberately: they implement
`02-surfaces`' "TAM HAS PROPOSED A SHAPE FOR YOUR WORDS", which the room has not rebuilt. They render
nowhere, so nobody meets the old UI through them.

### What the rebuild pass confirmed about the original finding

Two defects in this pass were found only by booting the room and looking — the workbench rail with its
WORKBENCH DOORS list, and nine identical "nothing to check it against" lines down a plan column. A
third was found by a test rather than by reading: the new WHAT GOT DONE WHILE YOU DIDN'T LOOK heading
claims an absence, and it rendered with no absence recorded. Reading the diff caught none of the three.

---

## Second pass, same day — no pre-design view survives

The first re-measurement left 5,900 lines of pre-design UI standing and said so. That is now zero: **every
view in the application comes from the designs**, and the measured zone count is **31 of 123** (still a
floor — runtime-generated zones cannot be string-matched).

| screen | audit | pass 1 | pass 2 |
|---|---|---|---|
| `01-room` | 4/12 | 6/12 | 6/12 |
| `02-surfaces` | 5/34 | 10/34 | 11/34 |
| `03-machinery` | 3/24 | 3/24 | 3/24 |
| `04-beyond` | 0/18 | 2/18 | 2/18 |
| `05-first-week` | 2/15 | 2/15 | 5/15 |
| `06-other-side` | 1/17 | 3/17 | 4/17 |
| `07-shell` | 0/3 | 0/3 | 0/3 |

### Rebuilt in this pass

- **Fog → WHAT HAS CHANGED UNDER YOU** (`05-first-week`). A tri-state colour overlay on a folder tree
  behind a 7d/14d/30d toggle became a ranked list where each row says in words why it is there.
- **Capabilities → WHAT THIS PRODUCT CAN DO THAT YOU DID NOT TEACH IT** (`05-first-week`). A capability
  pack is a borrowed default. IN FORCE is kept apart from ON OFFER.
- **Daily → WHAT CHANGED IN HOW THIS GETS USED** (`05-first-week`). Sparklines out; a direction in real
  units and the friction grouped by what it *is*. The weekly episode moved here under the reference's
  own heading.
- **Org settings → WHO IS IN THIS ROOM** (`05-first-week`). Roles described by what a person's word does
  to the fleet, not by what boxes are ticked.
- **Task board → WHAT IS ON** (`02-surfaces`). Ordered by whether it needs you, with WHERE YOU HAVE BEEN
  STANDING TODAY beside it.
- **TaskDetail + DesignReview → WHAT HAPPENED TO WHAT YOU WROTE** (`06-other-side`). One screen, and the
  four-state lifecycle instead of a resolved tick.
- **First run → DAY ONE** (`05-first-week`). The last screen wearing the old application, and the first
  one anybody sees.
- **Chrome**: toasts, the command palette, the waiting-room, and Login's one white button.

### Retired rather than translated — one call worth flagging

The **Graph / Observe surface** (4,619 lines, its own `docs/design/fleet-pulse/DESIGN.md`, concept locked
2026-07-02) is deleted. `01-room` answers the same question deliberately smaller — FLEET PULSE with a
sentence under it — and a product whose standing law is that watching should not be necessary cannot also
ship a watching screen. Its design doc is untouched; only the implementation that contradicts the
canonical one is gone. **This is the one place a design was superseded rather than translated.**

Also kept deliberately: `SpawnConfirmSheet` and `SpawnStatusCard`, orphaned but implementing a design
(`02-surfaces`' "TAM HAS PROPOSED A SHAPE FOR YOUR WORDS") the room has not rebuilt. They render nowhere.

### What booting kept finding

Every pass, the defects came from running it rather than reading it:

1. The workbench rail with its WORKBENCH DOORS list, and a `Fleet` door that had become a link to itself.
2. Nine identical "nothing to check it against" lines down a plan column — a finding turned into wallpaper.
3. One unanswered question rendered as two identical cards while the alarm band already carried it.
4. **The top bar reading "1 waiting on you" while the surface below read "not one of them needs you."**
   Both true of what they measured; together a contradiction, which is worse than either being wrong,
   because a reader cannot tell which screen to believe.

And two that only a test found: a heading claiming an absence that had not been recorded, and a dedupe key
matching a chip label case-sensitively so that two *different* agents asking the same question folded into
one — strictly worse than the duplicate it was written to fix.

**The audit's original correction still holds, and now has a second half.** A concern is not done when its
data is right; it is done when a person can see it. And it is not done when a person can see it either —
it is done when what they see does not contradict the screen next to it.
