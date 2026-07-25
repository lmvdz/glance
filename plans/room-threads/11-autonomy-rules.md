# Autonomy rules — the human's sentence, quoted where it acts
STATUS: open
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

## Cross-Repo Side Effects
None.

## Verify
- A proposal is generated only from real prior decisions, and cites each one.
- The proposal names at least one past interruption the rule would NOT have prevented, when one exists.
- Withdrawing a rule is one action and restores the prior behaviour.
- A rule quoted at the point of action shows the human's sentence verbatim, with its date.
- A rule invoked outside the clear reach of its sentence is marked, not silently applied.
