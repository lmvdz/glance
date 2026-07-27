# Autonomy rules — the human's sentence, quoted where it acts
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/rules.ts (new), src/squad-manager.ts, src/dal/store.ts, src/db/migrations.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
The fleet learns what it may settle alone by noticing patterns in decisions the human already made,
and stores each rule as his own sentence, quoted wherever it takes effect. There is no settings page.

## Approach
Reference: `reference/03-machinery.html` → 2a, 2b, 6a, 6b; `reference/04-beyond.html` → 4a, 4b;
`reference/05-first-week.html` → 2a, 2b.

1. A rule is **the human's exact sentence**, not a serialised predicate. It carries author, date,
   scope, invocation history, and a withdrawal that takes it back in one action.
2. Rules are **proposed from real evidence, never configured**: "Four times this month you were asked
   whether to take the reversible option, and four times you said yes. Should the fleet stop asking?"
   The proposal replays the actual past interruptions, with what he said and how long he took.
3. A proposal must state **what it would NOT have caught** — the design's own example keeps the
   credential interruption visible and says the rule would not have touched it. A rule that oversells
   itself is worse than no rule.
4. A rule is **quoted at every point it decides work**, in the human's words.
5. A rule applied where its sentence does not clearly reach **says so** rather than stretching.
6. Rules may never widen the non-delegatable class (concern 12).

## Built 2026-07-25

The missing piece turned out to be evidence, not the rule. A rule is proposed from decisions the human
already made — and no durable record of those existed. The audit log cannot serve: it is a no-op in file
mode, so half the fleet would silently have no evidence and every proposal would look unfounded.

So a `decision` node record now captures what was asked, what was chosen (verbatim, including free-text
answers), who decided, how long they took, and **why it reached a human at all**. Recorded in the manager
when a gate-class pending is answered; routine tool approvals are excluded, because 544 cards of
`Allow tool: bash` is noise and generalising from it would be learning the wrong thing.

`src/rule-proposals.ts` turns those into offers. Three properties are enforced there rather than left to
the caller:

- **It replays real decisions.** Every proposal cites the records it came from. A proposal that cannot
  show its evidence is a configuration prompt with better manners.
- **It states what it would NOT have caught**, by name. That clause is what keeps the human calibrated
  about what the rule actually buys.
- **It refuses to generalise across different questions or different reasons.** Four yeses to four
  different kinds of question is a coincidence with a sample size, not a pattern. A single inconsistent
  answer kills a proposal outright — the minority answer is precisely the case a majority-derived rule
  would get wrong, silently.

Decisions in the non-delegatable class never generate a proposal, because offering a rule that cannot be
accepted teaches the wrong thing about where the boundary is (concern 12).

`NodeRecordStore` now refuses a rule whose `proposedFrom` is empty or cites decisions that do not exist.
That is what stops a configured rule from claiming it was learned. The boundary check runs first, so an
overreaching rule is refused for the more important reason.

Still to build: the surface that shows a proposal and takes the human's sentence, and invocation
recording at the point a rule fires. `SquadManager.ruleProposals(nodeId)` is the seam for both.

## Cross-Repo Side Effects
None.

## Verify
- A proposal is generated only from real prior decisions, and cites each one.
- The proposal names at least one past interruption the rule would NOT have prevented, when one exists.
- Withdrawing a rule is one action and restores the prior behaviour.
- A rule quoted at the point of action shows the human's sentence verbatim, with its date.
- A rule invoked outside the clear reach of its sentence is marked, not silently applied.
