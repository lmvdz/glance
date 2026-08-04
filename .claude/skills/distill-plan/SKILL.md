---
name: distill-plan
description: Distill a plans/<name>/ directory into a self-contained visual page a human reads in minutes. Use when the user says "distill this plan", "make this plan readable", "digest plans/<name>", wants an infographic or before/after page of what a plan is, or before handing a plan to someone who wasn't in the room. Not for rendering structure alone — `bun scripts/render-plan.ts` already does that.
---

# distill-plan — a plan as ideas, not as files

DIRECTION.md's human contract has three clauses; the third is **comprehend** — "before/after HTML
digests and infographics of what the system did". `scripts/render-plan.ts` already renders a plan's
STRUCTURE (status pills, the dependency graph drawn, what's actionable right now). This skill is the
layer above it: the same plan as **ideas a person can hold**, which is the part a renderer cannot do
and a human currently does by hand.

Exemplar (built by hand, then decomposed into the contract below):
`plans/research-long-horizon-agent-memory/artifact/agent-memory-ledger.html`.

## The distillation contract — six rules, all six load-bearing

1. **Thesis first.** One sentence a reader can *disagree with*, not a summary of sections.
   "Memory is a ledger, not a search problem" — not "this plan covers memory architecture."
   If the thesis can't be disagreed with, you have a table of contents, not a distillation.
2. **A metaphor from the plan's own domain** — derived from the content, never decoration bolted
   on. Find the metaphor inside the subject. If you can't, say so and skip it; a forced metaphor
   is worse than none.
3. **A visual per IDEA, not per document.** Layer stacks, timelines, compare panes, annotated
   fixtures. The visual encodes the claim; prose shrinks to a paragraph beside it. A digest that is
   one visual and ten paragraphs is a document with a picture on it.
4. **Honest state, encoded in form.** Every claim about progress carries its real status, and
   status that went backwards stays visible. The exemplar's case-study table turned a row RED the
   day the plan's own lens found a gap in its runtime — that row is *why* the table is credible.
   A digest that only shows green is a brochure.
5. **Drill-down provenance.** Every claim points at the file, PR, commit, or concern that proves
   it. A reader must be able to go from any sentence to the artifact behind it in one hop.
6. **Identity per plan, never a house template.** Palette and motif come from the subject (the
   exemplar: ledger-green + strikethrough, because the subject IS a ledger). Two digests from this
   skill should not look like siblings. The contract fixes what a digest must DO, never how it
   looks.

## Shape

1. **Read the structure, don't re-derive it.**
   `bun scripts/render-plan.ts plans/<name> --json` emits the parsed concerns, statuses, blockers,
   and the actionable set from the SAME parser the HTML renderer uses. Use it; do not re-parse
   frontmatter by hand and drift from the renderer's logic.
2. **Read the plan's own prose.** `00-overview.md` (Outcome, Work, Order, Decisions, Out of scope),
   `DESIGN.md` if present, and any RECONCILE/BRIEF docs. The thesis and the metaphor come from
   here, not from the frontmatter.
3. **Ground the state.** Do not trust STATUS lines alone (`/reality-audit` exists because every
   status store here has lied). For any row you will render as done, check the code, the PR, or
   the merge. Where you did not verify, label it as claimed-not-verified — rule 4 covers backwards
   state, and unverified is a state.
4. **Write the page.** Load the `artifact-design` skill first for treatment calibration, then
   author a self-contained HTML file (inline CSS/JS, no external fetches — the CSP blocks them;
   theme-aware light and dark; wide content scrolls inside its own container).
5. **Place it.** `plans/<name>/DIGEST.html`, committed beside the docs — a digest that lives only
   in a chat is one that gets rebuilt from scratch next month. Publishing it as an Artifact is
   optional and additive, never a substitute for the file.
6. **Stamp provenance and staleness.** Header carries: date, the commit SHA distilled from, and the
   per-concern STATUS snapshot. A digest whose plan has moved on must be able to say so — the same
   rule the memory lane applies to summaries (regenerate from ground truth; never let a derived
   view quietly outlive its source).

## Rules with teeth

- **Regenerate, never patch.** Re-running this skill rebuilds the digest from the plan as it is
  now. Never hand-edit a DIGEST.html to "update" it — that is accretion, and it drifts.
- **No new claims.** A digest states what the plan says and what the code shows. If distilling
  surfaces something the plan doesn't know (a contradiction, a landed thing marked open), that is
  a finding for the plan doc, raised separately — not a fact invented in the digest.
- **Deferred work stays visible.** Never quietly drop concerns that are blocked, parked, or
  out-of-scope; name them and name what they wait on.
- **Never publish a plan digest as an Artifact without saying so** — plans contain internal
  strategy; the file is the deliverable, sharing is the operator's call.

## When NOT to use this

- The plan is 2 concerns and 40 lines: reading it IS the distillation.
