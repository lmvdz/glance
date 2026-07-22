# DIRECTION — read this before deciding anything

This is the north star for glance. Every agent — fleet unit, subagent, fresh session, foreign
harness — reads this before choosing priorities. When any local signal (a coverage matrix, a plan
doc, a finding, a backlog) conflicts with this file, this file wins. If you are about to suggest
work, test it against this page first.

## What we are building

**Glance is oversight for an autonomous engineering fleet. You glance, and you know.**

The product is two layers (amended 2026-07-22 — Lars's grand design, ratified at the-room design
gate; full rationale in plans/the-room/DESIGN.md):

- **Layer 1 is the room** — a buzz-shaped collaborative chat workspace: org-scoped channels where
  humans and agents are peers, browser-delivered, multiplayer by default (DB mode; file mode is
  the same room single-operator). It is the home screen. Users spin up and steer agents from the
  composer and never have to leave it.
- **Layer 2 is depth, entered from chat, never the home screen.** glance's depth: plan/workflow
  DAG, design revision, fleet economics. t3code's depth: the programmer's view — active/waiting
  agents, transcripts, diffs, steer. Every layer-2 *event* projects a card into the room; the
  room's rail (channels + active work) is a legitimate standing entrance — cards are the
  narrative way in, the rail is the standing way in.
- **Layer 2 never happens silently.** Any action in a depth surface emits a card back into the
  room. The room is the complete live projection of system state; history is durable in DB mode
  (channel rows), best-effort in single-operator file mode.
- **Cards are proofs, not agent self-reports** — gate verdicts, land assessments, done-proofs
  from the trust layer; event-bearing cards are manager-authored only and unforgeable by
  clients. This is the product's differentiation. The daemon brain is not rebuilt.
- **t3code is repositioned, not deprecated**: its thread grammar and card craft are absorbed into
  layer 1's rendering conventions; "t3code" names the programmer lens. The terax law generalizes:
  every expert surface — plan editor, economics view, programmer view — is a mode in one shell,
  opened on demand, never the default frame. **glance-desktop is superseded** (unused,
  non-working); its visual work is harvested via plans/the-room/CRAFT-HARVEST.md; plans/hub-shell
  is closed with a pointer to plans/the-room.

## The human contract (Lars, 2026-07-18, standing law)

The human is needed for exactly three things:
1. **Plan** — set direction, define outcomes.
2. **Review plans** — approve/adjust before execution.
3. **Comprehend** — before/after HTML digests and infographics of what the system did.

**Everything else belongs to the system.** If your answer to a problem hands a human an
operational verb (`list`, `rm`, `restart`, `curl`, triage-this, clean-that), you have found a
defect in the system — build the loop that removes the verb, never route the mop to the human.
A "Needs you" lane with more than a couple of items, or anything aging past hours, is a bug
report against the attention system (see plans/attention-autonomy), not a chore.

## Sequencing law (2026-07-18, foundation re-targeted 2026-07-22)

Foundation-loved-first stands. The foundation is now **the room**: plans/the-room waves 0–3, gated
by the love gate (plans/the-room/23-love-gate.md — Lars's reaction to the whole room experience:
cold-boot first frame, rail, timeline, composer verbs, doors). No new-surface feature work beyond
the-room's waves until that gate passes. **Room leads; the daily-driver program converges into
it** (needs-you cards ride the push latch; `glance here` terminal threads appear in the room's
rail) — ratified at the design gate, 2026-07-22.

## Decision tests (apply in order)

1. Does it violate the human contract (adds human ops work)? → wrong shape; redesign.
2. Does it contradict the sequencing law (features before a loved foundation)? → defer it.
3. Does it make the system more self-managing, more legible at a glance, or more trustworthy
   (proofs, gates, honest state)? → aligned.
4. Would it live outside the two-layer shape (a standalone surface that neither projects cards
   into the room nor opens from it)? → wrong shape; redesign.
5. Is a priority being derived from a local artifact (matrix, backlog, coverage gap) without
   re-anchoring on this page? → stop and re-anchor.

## Provenance

Written 2026-07-18 after Lars had to restate the direction four times in one day. Sources: his
verbatim statements (t3-face charter 2026-07-17; foundation-first sequencing, "where are the
threads", and the no-ops philosophy, all 2026-07-18). Amended 2026-07-22 with the two-layer
grand design (buzz workspace = layer 1; glance + t3code = layer 2), from his statements in the
the-room design session and the three gate rulings recorded in plans/the-room/DESIGN.md (room
leads daily-driver; rail is a standing entrance; DB-only multiplayer). Change this file only
with Lars's review.
