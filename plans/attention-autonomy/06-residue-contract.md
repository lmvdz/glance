# 06 — Residue contract + self-audit invariant

STATUS: open
PRIORITY: p2
COMPLEXITY: simple
BLOCKED_BY: 01
TOUCHES: src/watchdog.ts, src/doctor-probe.ts, src/attention-audit.ts (new; or observer.ts)

## Goal
Codify what MAY reach the human lane as a CHECK, not prose: (1) plan review/approval; (2) an
04-aggregated decision item; (3) comprehension artifacts; (4) structural escalations that survived
their caps (land-blocked past 20; validator-inconclusive past the escalation lane —
validator.ts:812). Invariant sweep (assessHealth extension + doctor probe): needs-you count > K
(default 3) OR oldest open item age > A (default 24h) ⇒ Observer-style self-audit issue naming
which lifecycle stage failed to fire — a bug report against the attention system, never a chore.
Adoption metric: residue-count-over-time grades the whole program.

## Verify
Unit test the invariant. Scratch-daemon with K+1 seeded items → a finding files; no push fires at
Lars.
