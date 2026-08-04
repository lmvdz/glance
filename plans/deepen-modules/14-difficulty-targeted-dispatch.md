# Difficulty-targeted dispatch — no learning signal from all-pass or all-fail work
STATUS: open
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

## Provenance
Lecture 6 (DAPO 30→50 via dynamic sampling), lecture 7 (Absolute-Zero proposer reward maximized
at intermediate difficulty). Pre-adjudicated in the brief; do not re-research.
