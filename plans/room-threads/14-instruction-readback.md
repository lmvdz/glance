# Instruction readback and the recorded objection
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/instructions.ts (new), src/squad-manager.ts, src/dal/store.ts, src/db/migrations.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
Before acting on a non-trivial instruction, an agent returns what it understood, separates what it can
undo from what it cannot, and may object exactly once — with a prediction that can later be checked.

## Approach
Reference: `reference/03-machinery.html` → 1a, 1b; `reference/05-first-week.html` → 6a, 6b.

1. A **reading** is line-by-line: each clause of the instruction, what the agent takes it to mean, and
   what it will do about it. Ambiguity is named as ambiguity, not resolved silently.
2. Each element is classed **reversible or not**, with its correction cost stated in the terms that
   matter ("re-running costs eleven minutes", "a published tag cannot be unpublished").
3. **Irreversible elements stay pending** until confirmed. The agent proceeds with the reversible parts
   meanwhile; it does not block the whole instruction on one clause.
4. An agent may **object once, before work**, and the objection must be **falsifiable** — a prediction
   with an outcome that can be checked. Vague discomfort is not an objection.
5. **Being overruled is not a fault.** The record keeps the objection, the overrule, and later the
   prediction's actual outcome, attributed to whoever overruled and whoever objected.
6. Objection outcomes feed agent records (concern 18) as evidence, never as a score.

## Cross-Repo Side Effects
None.

## Verify
- A reading is produced before any irreversible element executes; asserted by ordering, not by comment.
- Reversible parts proceed while an irreversible part waits.
- An objection without a falsifiable prediction is rejected at creation.
- An overruled objection's prediction is scored against reality when the outcome is known, and the
  record shows both the objection and the outcome.
- Re-reading an old instruction shows the reading as it was then, not a re-interpretation.
