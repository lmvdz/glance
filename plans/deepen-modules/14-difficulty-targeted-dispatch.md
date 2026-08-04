# Difficulty-targeted dispatch — no learning signal from all-pass or all-fail work
STATUS: in-progress
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/dispatch.ts, src/squad-manager.ts (escalation policy), src/model-outcomes.ts / task-outcome counters
MODE: afk

## Goal
CS329A borrow #1 (plans/research-cs329a/BRIEF.md): DAPO's dynamic sampling and Absolute-Zero's
proposer reward both encode the same fact — work that always succeeds or always fails carries
zero learning signal, and compute spent there is wasted. glance's logged escalate-cap burn and
verify-loop thrash (glance-fleet memory: workflow units burning the escalate cap 2-for-2) are
this failure mode live. Use existing task-outcome counters to classify work by observed
pass-rate band and shape the escalation/retry policy: stop re-dispatching into all-fail bands
(escalate to a human or a re-scope instead), stop burning verify-loop passes on all-pass bands.

## Slice ledger
- Slice 1 (2026-08-04, iteration 10): SHADOW instrumentation shipped — src/dispatch-difficulty.ts
  (pooled per-tier classifier over model-outcomes, off/shadow/apply flag) + a once-per-tick
  Dispatcher dep with transition-only logging + the 'difficulty' skipReason + .env.example entry.
  GATING DELIBERATELY UNSHIPPED: codex's blind pass produced three High findings, all survived —
  (1) the gate can only key mid pre-spawn while outcomes record light/heavy post-routing;
  (2) family pooling defeats model-route's escalation ladder; (3) deferral generates no new
  evidence and no escalation verb exists, so all-fail classes starve. An operator apply request
  is refused loudly and runs shadow.

## Open design questions (slice 2 — the gating redesign)
- Evidence unit: per-issue attempt history (the DAPO-faithful unit) instead of tier pools?
- Class shape: family-aware (gate only classes model-route cannot escalate out of)?
- The escalation verb: what actually happens to a starved class — attention card at which rung,
  re-scope proposal, race-style alternate strategy, or human hand-off?
- What clears a verdict: fresh manual-unit evidence, time decay, or operator ack?

## Provenance
Lecture 6 (DAPO 30→50 via dynamic sampling), lecture 7 (Absolute-Zero proposer reward maximized
at intermediate difficulty). Pre-adjudicated in the brief; do not re-research.
