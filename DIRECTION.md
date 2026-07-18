# DIRECTION — read this before deciding anything

This is the north star for glance. Every agent — fleet unit, subagent, fresh session, foreign
harness — reads this before choosing priorities. When any local signal (a coverage matrix, a plan
doc, a finding, a backlog) conflicts with this file, this file wins. If you are about to suggest
work, test it against this page first.

## What we are building

**Glance is oversight for an autonomous engineering fleet. You glance, and you know.**

The product is three organs, deliberately separate:
- **t3code's face** — its look, feel, **layout**, and interaction grammar (threads-first,
  conversation-centric, composer as hub). Not "inspired by": the t3 experience.
- **terax's body** — the Tauri desktop shell (terminal/editor/ADE) hosting that face.
- **glance's brain** — the daemon: the fleet, the trust layer, landing, attention, comprehension.

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

## Sequencing law (2026-07-18)

The desktop foundation — t3code's look/feel/layout/ability, to a state Lars *loves* — comes
**before** layering glance features onto it. Foundation concerns ship first; glance surfaces
(dashboards, factory panels, comprehension views) integrate only after the foundation gate
(plans/t3-face concern 13: Lars's own reaction) passes. "Deep in tools for the AI, minimal
management surface for the human" governs both sides.

## Decision tests (apply in order)

1. Does it violate the human contract (adds human ops work)? → wrong shape; redesign.
2. Does it contradict the sequencing law (features before a loved foundation)? → defer it.
3. Does it make the system more self-managing, more legible at a glance, or more trustworthy
   (proofs, gates, honest state)? → aligned.
4. Is a priority being derived from a local artifact (matrix, backlog, coverage gap) without
   re-anchoring on this page? → stop and re-anchor.

## Provenance

Written 2026-07-18 after Lars had to restate the direction four times in one day. Sources: his
verbatim statements (t3-face charter 2026-07-17; foundation-first sequencing, "where are the
threads", and the no-ops philosophy, all 2026-07-18). Change this file only with Lars's review.
