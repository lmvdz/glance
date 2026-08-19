# DIRECTION — read this before deciding anything

This is the north star for glance. Every agent — fleet unit, subagent, fresh session, foreign
harness — reads this before choosing priorities. When any local signal (a coverage matrix, a plan
doc, a finding, a backlog) conflicts with this file, this file wins. If you are about to suggest
work, test it against this page first.

## What we are building

**Glance is the neutral landing rail for agent-written code.**

*Your agents write the code. glance decides what's safe to land — and shows its receipts.*

Amended 2026-08-04 — the one-thing ratification; full rationale in plans/landing-rail/BRIEF.md
(an Aug-2026 market scan and a ground-truth capability audit of main@350f367f, both recorded
there as settled inputs). This replaces the two-layer framing of 2026-07-22 as the leading
shape. What that amendment said is parked, not withdrawn, and its supersessions still stand —
see "What is parked" below.

- **One sentence decides everything.** Any agent, any harness, writes in an isolated worktree;
  glance is the only path to main; a land is an evidence bundle — verify gates green with
  unproven-green rejection, cross-lineage reviewers with *measured* precision, failure-set diff
  against the known baseline, rollback armed. **A human approves a receipt, not a 400-line
  diff.**
- **"Only path to main" binds agent-written code, and it binds as fast as the rail can carry
  it.** Authorship is the test: a change an agent wrote goes through the rail. Where the rail
  cannot yet carry a class of change, that is a gap on the landing-rail ladder — recorded there,
  worked off there, never read as standing permission to route around it. Changes a human wrote
  are outside the rule, this amendment among them: the receipt exists to spare a human a diff
  they did not write, and there is nothing to spare them when they wrote it.
- **Neutrality is the moat.** The rail belongs to no harness and no vendor: claude, codex, grok,
  whatever ships next — all land the same way, through the same gates, recorded in the same
  ledgers. The moment the rail favors the harness that owns it, it is worth nothing to the mixed
  fleet, and the mixed fleet is who needs it.
- **Receipts are proofs, not agent self-reports** — gate verdicts, land assessments, reviewer
  verdicts carrying each reviewer's measured precision, done-proofs from the trust layer;
  manager-authored and unforgeable by clients. This is the product's differentiation, and it is
  unchanged from 2026-07-22 — only its carrier moved: the receipt now holds the proof the card
  used to. The daemon brain is not rebuilt. **When the rail judges its own change** — which the
  sequencing law below requires of it daily — author and subject are the same system, and the
  receipt's independence rests entirely on the foreign reviewers and the gate diff. Those
  receipts still count as evidence; they are the ones to read hardest, and the reason the
  foreign reviewers are not optional.
- **The receipt is the surface.** A land's evidence bundle renders as a self-contained page
  beside the land ledger and as a PR comment: legible cold, no daemon needed to read it, no
  webapp needed to ship it. Depth — transcripts, diffs, plan DAGs, economics — is reachable from
  a receipt; it is never the thing a human is asked to read first. Two ledgers stand behind it
  and are not the same artifact: the **land ledger** (one row per land, what happened) and the
  **reviewer ledger** (adjudicated cross-lineage findings, where a reviewer's measured precision
  is computed). Terms of art used above — unproven-green rejection, failure-set diff, measured
  precision, and the market entities named under Falsifiers — are defined in
  plans/landing-rail/BRIEF.md. Precedence governs priorities and claims, not vocabulary: a
  definition that turns out wrong gets fixed there, not overruled here.
- **No land happens silently.** The 2026-07-22 rule that no depth action goes unprojected keeps
  its force and changes its target: every land the rail performs — approved, refused, or rolled
  back — emits a durable receipt, and a refusal's receipt is the one that matters most. A land
  the rail performed but did not receipt is the same defect an unprojected action was.
- **"You glance, and you know" survives, re-pointed.** What you glance at is one land's
  evidence, not a fleet dashboard. **"Oversight for an autonomous engineering fleet" is
  withdrawn as the headline**: that is the fleet-supervisor lane, and that lane is a graveyard —
  GitHub ships Agent HQ as free first-party mission control, the paid attempts around it are
  dead, and our own adoption counters show fourteen days of zero use with zero room interactions
  ever. Oversight is now a property of the rail, not the product.

## What is parked (2026-08-04)

Parked means frozen, not deleted and not disowned. The code stays on main, keeps its gates
green, and keeps being maintained; the plan directories stay; the history stays readable; every
parked thing keeps its design docs so that unparking is a decision rather than an archaeology
project. Nothing on this list may be extended *for its own sake* — if a parked surface has to
change so that a land can happen, that change is rail work and is judged as rail work. Nothing
on this list may be ripped out either: deleting it is its own kind of new work, and it is not
the work.

- **The room / chat surface** — plans/the-room's 24 concerns and shipped waves 0–3: the
  buzz-shaped channels, room messaging, the doors, card projection, the layer-1 home-screen
  claim. It shipped, its gates are green, and the counters record no human interaction with it,
  ever. It is the first thing to unpark if the rail earns an audience that then asks for
  somewhere to talk. Its love gate (plans/the-room/23-love-gate.md) is parked with it, unfailed
  and unrun. One word now does two jobs: **"the rail" unqualified means the landing rail from
  here on** — the room's channel rail is always named as the room's rail, and it is parked.
- **Voice** (and the per-org BYO-key surface behind it), **feedback + payments**, **plan-votes
  and vision**, **`here.ts`**, and **webapp-as-product** — that last one parks the *ambition*,
  not the app: the React webapp keeps running and keeps being repaired, it simply stops being
  the thing we are trying to make people want.

Kept, because they serve the rail and would only have to be rebuilt: **presence/leases** (two
agents must never land the same branch), **the attention ladder** (a receipt nobody is asked to
look at is not oversight), **the plane loop**, **memory lane / DecisionLedger** (this is where
the reviewer ledger lives and where measured precision is computed), **cost attribution** (a
land receipt carries a cost line).

The attention ladder outlives the room that used to render it: the "Needs you" lane is a queue,
not a screen, and with the room parked a needs-you rides the receipt itself and the existing
notification path — a PR comment, a push, a CLI line — never a surface built for it. Counting
that queue is how the human contract's aging rule is applied. If an escalation is left with
nowhere to go, that is a rail defect and gets fixed in the rail, not by unparking a home screen.

Layer-2 depth is not a third category: the surfaces that serve a receipt are kept and reached
from it; the surfaces that only served the room are parked with it. The supersessions recorded
by the 2026-07-22 amendment still stand — **glance-desktop is superseded** (visual work
harvested via plans/the-room/CRAFT-HARVEST.md), plans/hub-shell stays closed, and "t3code" names
the programmer lens rather than a separate product. Parking the room un-supersedes nothing. The
terax law also stands and now has less to govern: whenever a UI unparks, every expert surface is
a mode in one shell, opened on demand, never the default frame.

## The human contract (Lars, 2026-07-18, standing law)

The human is needed for exactly three things:
1. **Plan** — set direction, define outcomes.
2. **Review** — approve/adjust plans before execution, and approve a land receipt after it
   (widened 2026-08-04 from "review plans"; the rail's one human verb belongs here, see below).
3. **Comprehend** — before/after HTML digests and infographics of what the system did.

**Everything else belongs to the system.** If your answer to a problem hands a human an
operational verb (`list`, `rm`, `restart`, `curl`, triage-this, clean-that), you have found a
defect in the system — build the loop that removes the verb, never route the mop to the human.
A "Needs you" lane with more than a couple of items, or anything aging past hours, is a bug
report against the attention system (see plans/attention-autonomy), not a chore.

**Approving a land is review, not ops (2026-08-04).** The one human verb the rail keeps is
"ship it" on a receipt. That verb had no home in the old act 2, which covered only plans before
execution, so act 2 is widened above rather than stretched: reviewing a receipt is the same act
as reviewing a plan, aimed at the other end of the work, and it is the only place a human
belongs in the land path. **Approval is the signal, not the button.** Once a human says ship it,
the system performs the merge and everything after it; a human pressing the merge button is
tolerable where the rail cannot yet act on the signal, and that too is a gap on the ladder.
Everything else mechanical around the verb — rerunning a flaky gate, chasing a reviewer,
rebasing, retrying, cleaning up after a refusal — belongs to the system, always. If a human has
to read the diff to make the call, the receipt is the defect.

## Sequencing law (2026-07-18, foundation re-targeted 2026-08-04)

Foundation-loved-first stands; it has always been one law with a moving referent. The foundation
is now **the rail**: the land path and the receipt it produces (plans/landing-rail — GOAL.md
carries the ladder, tiers 0–5; where that ladder and this page disagree, this page wins). Loved,
for a rail, is not a matter of opinion, so the gate is dogfood: **the rail lands its own PRs,
with full receipts citing measured reviewer precision, for two weeks.** Two weeks in which every
PR the loop produced went through the rail and left a receipt; an agent-authored land that
routed around the rail restarts the clock. Lars declares the gate passed, reading the receipts —
the same hand that ratifies this page. If the rail cannot land its own change, that failure is
the next unit of work, not a footnote.

**No new-surface feature work beyond the rail and its receipt until that gate passes.** The
receipt is not an exception to this law, it is the foundation the law is protecting; the gate
cannot pass without it. **Keeping parked code green, running, and repaired is not feature work**
and is never deferred by this law — a parked surface is frozen, not abandoned, and letting one
rot is how parking turns into the deletion this page forbids. The room's love gate no longer
governs sequencing — see "What is parked".

## Decision tests (apply in order)

Two checks gate the ladder rather than sitting in it — run both *before* test 1, every time:

- Is this priority being derived from a local artifact (matrix, backlog, coverage gap) without
  re-anchoring on this page? → stop and re-anchor. plans/landing-rail is a local artifact too:
  its brief settles inputs so they are not re-litigated, which is not the same as outranking
  this page.
- Has a falsifier fired? → stop and report. The pivot call is Lars's, never an agent's.

Then the ladder. The order within it changed on 2026-08-04: the shape test now runs *before* the
alignment test, because a parked surface can be made more legible and more trustworthy all day
and still be the wrong work.

1. Does it violate the human contract (adds human ops work)? → wrong shape; redesign.
2. Does it contradict the sequencing law (features before the foundation is proven — the
   foundation is now the rail)? → defer it. Repair and upkeep of what already exists, parked
   included, is exempt.
3. *(amended 2026-08-04, replacing the two-layer shape test)* Does it serve a land — make the
   rail safer, its evidence stronger, its receipt more legible, or reach one more harness?
   Serving a land is a requirement here, not a tiebreak: if the answer is no it waits, however
   good it would be, whether it grows a parked surface or an entirely new one. Standing alone is
   no longer disqualifying, though: a receipt that reads cold, in a PR comment, on a repo that
   has never run the daemon, is exactly right.
4. Does it make the system more self-managing, more legible at a glance, or more trustworthy
   (proofs, gates, honest state)? → aligned.

## Falsifiers (standing re-check)

The thesis is a bet on an empty lane, and an empty lane can be filled by somebody else. Re-check
all four whenever a tier of the landing-rail ladder closes, and monthly regardless — a re-check
with no trigger never happens, and one with no record cannot be shown to have happened, so each
re-check lands as a row in the plans/landing-rail ledger, holding or clearing. If one fires:
stop, report, recommend. Do not pivot on your own, and do not quietly keep building.

1. Copilot review becomes a *required* reviewer and GitHub wires Agent HQ → merge queue into
   native gated auto-land with rollback.
2. Aviator ships an agent-fleet-native autonomous mode with harness integrations.
3. Cursor re-aims Graphite's queue at cross-harness agent diffs.
4. Gas City commercializes the Refinery first — or proves the segment won't pay.

The market read behind these — landing rail empty and paid, fleet supervisor a graveyard,
standalone review a knife fight — is settled input. Re-litigate the falsifiers, not the scan.

## Provenance

Written 2026-07-18 after Lars had to restate the direction four times in one day. Sources: his
verbatim statements (t3-face charter 2026-07-17; foundation-first sequencing, "where are the
threads", and the no-ops philosophy, all 2026-07-18). Amended 2026-07-22 with the two-layer
grand design (buzz workspace = layer 1; glance + t3code = layer 2), from his statements in the
the-room design session and the three gate rulings recorded in plans/the-room/DESIGN.md (room
leads daily-driver; the room's channel rail is a standing entrance; DB-only multiplayer) — that
amendment's supersessions stand, its layer-1 claim is parked. Amended 2026-08-04 with the
landing-rail thesis: one thing, the neutral rail; the room parked; falsifiers standing. Sources:
the Aug-2026 market scan and the ground-truth capability audit of main@350f367f, both recorded
as settled inputs in plans/landing-rail/BRIEF.md — and Lars's ratification, which is the merge
of the pull request carrying this amendment. Change this file only with Lars's review.
