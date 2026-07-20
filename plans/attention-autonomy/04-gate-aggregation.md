# 04 — Gate aggregation: N similar gates → ONE decision item

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/attention-cluster.ts (new), src/server.ts, src/attention-ladder.ts
MODE: fan-out matcher joins 02's gauntlet scope

## Goal
Cluster open gate-class/risky pending requests across units by (kind, title-token-class, repo,
option-set) — opportunity.ts's exact shape (token-jaccard, fingerprint dedup), min cluster 2. The
ladder serves ONE pending-approval item ("5 units blocked on approval class X"). Answer fan-out is
FAIL-CLOSED: only to members whose kind and options match exactly (snapToOption per member, never
cross-kind); near-matches stay individual. The cluster answer stamps a 02 precedent, so the sixth
identical ask never reaches the lane — the "absorbed into a plan-level decision" mechanic.

## Verify
Unit tests on cluster/fan-out matching with adversarial near-miss options pinned. Scratch-daemon
with 3 units raising the same gate.
