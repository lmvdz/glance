# Cold start — six borrowed defaults and a ledger of what we do not know
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/rules.ts, src/unknowns.ts (new), webapp/src/components/hub/*, tests
BLOCKED_BY: 11
MODE: afk

## Goal
On day one the product is honest about the fact that it knows nothing about this human: it says which
behaviours are borrowed from other teams, how to reverse each, and what it cannot yet know.

## Approach
Reference: `reference/05-first-week.html` → 1a, 1b.

1. **Six defaults, each marked borrowed**, each individually reversible, each replaced over time by one
   of the human's own sentences (concern 11). Borrowed is a first-class state, not a silent fallback.
2. **One question has no default**: out-of-hours contact. It is asked, not guessed.
3. An **unknowns ledger** is a real surface: what the product does not know, what evidence would settle
   it, how large a sample it needs, and what it costs to keep not knowing.
4. The ledger **shrinks visibly** as evidence accumulates — the first week has a shape, and the human
   can see the fleet learning rather than being told it learns.
5. This concern supplies the provenance that autonomy rules (11), stalls (13), and agent records (18)
   each depend on; none of them may invent a confidence they have no sample for.

## Cross-Repo Side Effects
None.

## Verify
- A fresh install shows six defaults, all marked borrowed, all reversible in one action.
- Out-of-hours contact is unset and asked for.
- Each unknown names its settling evidence and required sample size.
- A rule proposal that lacks the sample its own ledger entry demands is not offered.
