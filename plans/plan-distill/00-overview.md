# Plan distillation — every plan digestible as human ideas, not just files

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural

> Side mission, recorded 2026-07-26 at Lars's direction ("i would love that all of our plans could
> be digested and viewed in this fashion... the distillation of the content into human readable
> ideas, metaphors, and content"). WIP-gate note: recorded deliberately as a side mission by
> operator instruction, not selected by a scanner. Authoring is legal now; any webapp surface
> waits behind the-room's love gate per DIRECTION.md's sequencing law.

## Outcome

Any `plans/<name>/` directory can be distilled into a self-contained visual page a human reads in
minutes: the thesis in one sentence, a metaphor drawn from the plan's own domain, each concern's
idea rendered visually rather than as prose walls, honest state, and drill-down links back to the
raw docs. This is the human contract's third clause ("comprehend — before/after HTML digests and
infographics of what the system did", DIRECTION.md) made real for plans, not just runs.

## The exemplar

The agent-memory-ledger artifact (claude.ai/code/artifact/4879ed9b-…, built 2026-07-25/26 from
`plans/research-long-horizon-agent-memory/`). What made it work, extracted as the distillation
contract:

1. **Thesis first** — one sentence a reader can disagree with ("Memory is a ledger, not a search
   problem"), not a summary of sections.
2. **A metaphor from the subject's own world** — the hospital ward / night-shift interlude did more
   comprehension work than any table; it was derived from the content (strike-through charting is
   the actual mechanism), not decoration.
3. **A visual per idea, not per document** — the layer stack, the retrieval-tie panel, timelines,
   compare panes. Visuals encode the claim; prose shrinks to a paragraph beside each.
4. **Honest state, encoded in form** — the position→practice table with IN PLACE / DECIDED / OPEN
   tags that changed as reality changed. A digest that flatters is worse than none.
5. **Drill-down provenance** — every claim points back to the file/commit/PR that proves it.
6. **Distinct identity per plan** — palette and motif derived from the subject (ledger green +
   strike-through), never one house template ("not exactly the style").

## The recursion (why this fits glance's architecture)

A plan digest IS the ledger position's L2 summary, applied to plans: **regenerated from ground
truth on change (never hand-maintained), reference-never-restate (links to concern files, PRs,
gate logs), drill-down pointers everywhere, and excluded-not-annotated staleness** (a digest that
lags its plan must say so or die). Concern 06 of room-threads and this plan should share
vocabulary and, eventually, machinery.

## What already exists (extend, don't duplicate)

- `scripts/render-plan.ts` (2026-07-24) — renders plan STRUCTURE: status pills, priority stripes,
  the dependency graph drawn, "actionable right now" computed. Deterministic, no LLM. This is the
  data layer a distillation pass consumes — not the thing to rebuild.
- The practice of per-plan visual-review artifacts (room-threads 00 links one) — currently
  hand-made in Claude sessions; this plan makes the practice a capability.
- The comprehension lane (`plans/comprehension`) — owns run/fog comprehension; this plan owns
  plan comprehension. Same contract clause, different subject; keep the seams explicit.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 distillation contract + skill | The 6-point contract above as a `/distill-plan` skill: input = plans/<name> + render-plan.ts's parsed structure; output = self-contained DIGEST.html honoring the contract | architectural | .claude/skills/distill-plan, scripts/render-plan.ts (export the parser) |
| 02 regeneration + staleness honesty | Digest carries provenance (commit, date, per-concern STATUS hash) and is regenerated on plan change; a stale digest renders its own staleness banner rather than lying | architectural | skill, scripts, maybe a daemon hook post-STATUS-flip |
| 03 where digests live + surfacing | plans/<name>/DIGEST.html committed beside the docs; `glance` serves/opens them; LATER (post-love-gate): the room projects a digest card when one regenerates | mechanical | scripts, src/server.ts (static serve), room card kind (deferred) |

## Not yet specified

- Whether generation runs via a Claude session skill (cheap, human-in-loop, matches how the
  exemplar was made) or a daemon-driven LLM pass (autonomous, costs tokens on every plan change).
  Start with the skill; promote to daemon only if the practice sticks — dogfood before machinery.

## Out of scope

- One house style. The contract fixes what a digest must DO; identity stays per-plan.
- Replacing render-plan.ts — it is the structural substrate, not a competitor.
- Any webapp surface before the love-gate verdict (sequencing law).
