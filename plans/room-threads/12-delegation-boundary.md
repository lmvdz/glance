# The boundary no rule may cross
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/authz.ts, src/rules.ts, src/server.ts, src/squad-manager.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
Credentials, spending, deletion, publishing and legal-edge actions always reach a human, and no
learned rule can ever widen that.

## Approach
Reference: `reference/04-beyond.html` → 3a, 3b, 5b; `reference/05-first-week.html` → 1a, 2b.

1. The class is **product policy, not configuration**. On day one it is already present and marked
   "fixed — not a default and not borrowed; this cannot be turned off."
2. **Enforced server-side.** A client-side label is not enforcement. The check lives where the action
   is taken, not where it is displayed.
3. The human can **see the class and argue with it** — moving something out of it is a deliberate,
   attributable act with its consequence stated, and moving something IN is always allowed.
4. Each member explains, in one sentence, why no rule can cover it.
5. A rule proposal that would touch this class is refused at generation time, not at invocation.

## Cross-Repo Side Effects
None.

## Verify
- A learned rule that would widen the class is refused, with a test per member of the class.
- The enforcement point is server-side; a forged client request is still refused.
- The class renders with a one-sentence justification per member.
- An argued-out member records who moved it and when.
