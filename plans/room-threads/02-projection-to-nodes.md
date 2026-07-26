# Cards land at the node they describe
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (projectedChannelId → projectedNodeId), src/server.ts, tests
BLOCKED_BY: 01
MODE: afk

## Completed 2026-07-25

`src/projection-classes.ts` replaces the binary `ESCALATION_CARD_KINDS` list with a declared table:
every event class states where it projects AND **why**, in a sentence written for someone who disagrees
with the choice. A projection table with no reasons is a volume knob with more steps, which is what
concerns 26 and 27 were both symptoms of.

The room stays small. `unit-spawned`, `turn-finished`, `verification-ran`, `pr-opened` and
`return-emit` all land at the node — "that tests RAN is not a result; the verdict projects, the run
does not."

**Provenance travels with the card and is checked before it is written.** A unit may say anything about
itself and nothing about anyone else, so a card whose subject is a different node is refused as a
forgery regardless of which emit site produced it — and it is logged as REFUSED rather than as a
transient failure, because those want different responses. A card that interrupts a person must also
carry either openable evidence or the rule that decided it; a claim a person cannot open is one they
have to take on trust, which is the opposite of a proof card.

An unclassified event stays at its node. That is deliberately the OPPOSITE default from the delegation
boundary, for a stated reason: there, an unclassified autonomous action is refused because the cost of
a wrong guess is irreversible. Here the cost of a missed card is that someone looks at the node, and
the cost of an unearned one is that every card beside it stops being read.

## Landed earlier

Node addressing works: routine lifecycle telemetry lands at the unit's node channel, escalation classes
surface in the unit's own room, and a node channel inherits the visibility and memberships of the room
its unit came from rather than inventing a second authorization scheme.

Still open, and why this concern is not done: the proof-card contracts below. A projected card is not yet
unforgeable-by-provenance, and event classes do not yet declare what they project.

## AMENDED 2026-07-25 (RECONCILE finding 3)

"Everything else stays at its node" is too absolute. The design requires manager-authored, unforgeable
**proof cards** in the room for layer-2 events, while local detail stays local and noise stays
suppressed. A `projectedNodeId` alone carries neither provenance nor a projection policy.

So the binary upward-flow rule is replaced by **explicit event classes with proof-card contracts**:

- Each event class declares whether it projects to the room, and what it projects — never the raw event.
- A projected card is **authored by the manager and unforgeable by a unit**; a unit cannot manufacture
  a room presence for itself.
- A projected card carries **provenance**: which node, which agent, which rule fired (concern 11), and
  the evidence behind it.
- Everything not in a projecting class still stays at its node. The anti-firehose goal is unchanged;
  only the mechanism is.
- Proposed plan nodes (concern 20) are distinguished from started work; a proposal is not in flight.

## Goal
Lifecycle telemetry stops reaching the root channel and lands at its own node, so lane separation is a
property of addressing rather than a rule anyone has to enforce.

## Approach
1. `projectedChannelId` is the single seam that decides where a card goes — this is why the change is
   cheap. It becomes `projectedNodeId`, resolving to the node the card is about.
2. Upward flow is ESCALATION ONLY: needs-you, gate verdicts, land merges, plan revisions, failures.
   Everything else stays at its node. Propagating all activity upward rebuilds the firehose one level
   up, which is the failure this plan exists to fix.
3. Keep concern 27's worthiness rules intact — they were hard-won and all three were found by booting
   the room, not by tests: one card per failure (`error → error` suppressed), an error class a human
   can read, and no completion card when there is no summary to report.

## Cross-Repo Side Effects
None.

## Verify
- A unit's `unit-spawned` / `verification-ran` appear at its node and NOT in the root channel.
- A `needs-you` on a deep node surfaces at the root; a `unit-turn-finished` on the same node does not.
- Concern 27's three worthiness tests still pass unchanged.
- A subagent's telemetry does not reach its parent unit's channel unless it asks or fails.
