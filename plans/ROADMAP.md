# ROADMAP — deferred bets (DRAFT, pending Lars ratification)

The future lane of the plan layer. DIRECTION.md says what is true now; this file holds bets
deliberately **not** being worked, each with the trigger that reopens the question. Entries are
paragraphs, not plans: no decomposition, no Plane issues, no STATUS lifecycle. When a trigger
fires, the entry goes through /plan into its own plans/<name>/ directory and gains a pointer
here. Adding, reordering, or triggering an entry is Lars's call.

Rules (mirror of the plan layer's three ratification states):
- **future** = an entry in this file (a decision not to decompose yet + a trigger).
- **active** = a plans/<name>/ directory. Status lives in concern frontmatter, never in folder
  location — /wip, sync-plans, and reality-audit are the derived views.
- **archived** = plans/.archive via the delete cascade.

---

## Attested track record

**Bet:** glance's fleet exhaust — done-proofs, ValidationRecords, land assessments, receipts,
per-harness cost ingestion, all issuer-stamped (DESIGN.md federation-provenance amendment,
2026-07-23) — aggregated by (harness, model, agent profile, capability) into a verified
performance ledger: what each doer actually delivered, attested by gates the doer doesn't
control. Cross-vendor by construction (three lineages behind one driver seam). Proto-version
already live: the harness registry's `verified` tier + degradation ladder.

**Internal product first (useful at N=1):** replace the hand-curated model-routing table
(cost/intelligence/taste, maintained from anecdotes) with measured routing — dispatch by
attested track record. **Institutional product later:** when vendors sell agent capabilities
into other orgs' rooms, the buyer's first question is "show me its verified history"; this
ledger is that answer in a form the vendor cannot forge. Everything higher in the missing
institutional stack (reputation, insurance, recourse) consumes this layer.

**Shape when active:** a layer-2 depth surface (sibling of fleet economics), notable events
projecting cards into the room, aggregates feeding dispatch. Fits the two-layer law; no new
trust machinery — a projection over records already persisted.

**Trigger:** the-room love gate passes (sequencing law), or a concrete federation counterparty
appears — whichever comes first.
