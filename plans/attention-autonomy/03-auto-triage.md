# 03 — Auto-triage of stuck units (the T1 agent)

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
BLOCKED_BY: 01, 02 (may ship early with `answer` disabled)
TOUCHES: src/attention-triage.ts (new), src/squad-manager.ts, src/answers.ts

## Goal
Past T1, dispatch a triage pass. Two-stage cost shape: smol classification call (transcript tail +
request; decideTyped idiom) choosing {answer, restart, reroute, absorb, close-with-note,
investigate}; only `investigate` spends a full answer-shaped unit (answers.ts — no-land, durable).
Action wiring exists: answer → answerPending GATED through 02 (a triage verdict is never its own
authority); restart → SquadManager.restart(); absorb → 04's cluster; close-with-note → interrupt +
resolution record. Budget: OMP_SQUAD_TRIAGE_MAX_CALLS_PER_HOUR (default ~6), once per item per TTL
window; automation-log loop `attention-triage`; failure-memory integration (stop restarting the
same failure class twice). Each decision recorded via decision-evidence + resolution log.

## Verify
Scratch-daemon: trivial-input unit answered within T1; transient-error unit restarted; gate-class
items never touched. The `answer` action rides 02's gauntlet.
