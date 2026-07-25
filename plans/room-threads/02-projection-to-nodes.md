# Cards land at the node they describe
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (projectedChannelId → projectedNodeId), src/server.ts, tests
BLOCKED_BY: 01
MODE: afk

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
