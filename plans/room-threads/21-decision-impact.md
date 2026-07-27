# What a decision cost, and what unwinding it would cost
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/cost.ts (new), webapp/src/components/hub/*, tests
BLOCKED_BY: 17
MODE: afk

## Goal
The fleet can answer "what would it take to undo this" and "what did that interruption cost" with
retained evidence rather than a re-derivation after the fact.

## Approach
Reference: `reference/04-beyond.html` → 5a, 5b, 6a, 6b.

1. **Reversal cost is dependency-aware** — undoing 3.2 is not undoing 3.2 alone if 3.3 built on it.
2. **Irreversible elements are named with their nearest repair**, not marked simply impossible. "The tag
   cannot be unpublished; the repair is a superseding release" is useful; "irreversible" is not.
3. **Spend is separated from waste**, with the cause of the waste attributed — an interruption that
   idled four agents for 46 minutes has a cost and a reason.
4. **Cost is disclosed only where it changes the decision.** A running cost ticker on every screen trains
   people to ignore it; the number belongs next to the choice it should influence.
5. All of this reads from retained records (concern 17). Reconstructing cost after the fact from logs is
   exactly the fragility this concern exists to remove.

## Cross-Repo Side Effects
None.

## Verify
- Reversal cost includes downstream dependents; asserted with a three-deep chain.
- Every irreversible element has a named nearest repair.
- Waste is attributable to a cause, and an interruption's idle cost is queryable.
- Cost appears at decision points and does not appear as ambient chrome.
