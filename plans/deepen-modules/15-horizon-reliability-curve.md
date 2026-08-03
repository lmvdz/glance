# Horizon × reliability curve — land-rate conditioned on task size
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/dispatch-ledger.ts / dispatch outcome records, src/adoption-counters.ts or a new metrics module, /api route, webapp panel
MODE: afk

## Goal
CS329A borrow #2 (plans/research-cs329a/BRIEF.md): METR's result — a model completes 59-minute
tasks at 50% reliability but only ~15-minute tasks at 80% — shows a single unconditioned success
rate hides the axis operators actually plan around. glance already records per-attempt outcomes
with timing; compute and render the curve: for each reliability level (50%/80%), the largest
task-size band (wall-clock or diff-size proxy) where land-rate clears it. Surfaces as an API
payload + a workbench panel, and gives the fleet's autonomy policy an empirical anchor ("this
class of task is above the fleet's 80% horizon — don't autoland").

## Provenance
Lecture 8 (METR horizon curve; "model performance is consistent closer to contractor times").
Pre-adjudicated in the brief; do not re-research.
