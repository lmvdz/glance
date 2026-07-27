# The boundary no rule may cross
STATUS: done
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

## Built 2026-07-25

`src/delegation-boundary.ts` holds the class, one justification sentence per member written for a
person, and the action map. Enforcement is server-side at two chokepoints — `applyCommand` (for any
command carrying `source: "auto"`) and `land()` (for `opts.auto`) — alongside, not inside, the existing
role check, because they answer different questions: `authz.ts` asks which human tier may act, this asks
whether it may happen with no human at all.

The one door out is a `DelegationGrant`: a human argues a single action out of the class, by name, with
their own reason, revocably. Persisted in both stores (migration `0017_delegation_grants` + RLS) and read
fresh at every enforcement point — a revocation that only applies after a restart is not a revocation.

**`OMP_SQUAD_AUTOLAND` defaulted to true and nobody had decided it.** Rather than break autonomous
merging or leave it anonymous, the flag now materialises at boot as a grant that states where it came
from and admits nobody has argued for it in their own words. It is deliberately NOT re-created after a
revocation, or a restart would silently undo a person taking the permission back.

A rule naming a boundary action is refused **at creation**, not at invocation — otherwise the boundary
would depend on every future call site remembering to check, and the one that forgets is a hole nobody
can see.

Fail-closed throughout: an unreadable grant store yields no grants, a half-decoded grant row is not a
grant, a grant whose class disagrees with its action does not carry, and a revoked grant is not a grant.
An exhaustiveness test requires every `ClientCommand` type to be explicitly classified, so a new action
cannot default into being permitted.

Still open, deliberately: `credentials` and `legal` have no action entries because no backing system
exists yet. Following `authz.ts`'s own discipline — an action mapped to a class that does not exist
would authorize against nothing, which reads as enforcement while being decoration. The classes are
declared, shown, and enforce the moment an action lands in them.

## Cross-Repo Side Effects
None.

## Verify
- A learned rule that would widen the class is refused, with a test per member of the class.
- The enforcement point is server-side; a forged client request is still refused.
- The class renders with a one-sentence justification per member.
- An argued-out member records who moved it and when.
