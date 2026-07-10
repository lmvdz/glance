# Reproducible eval set for efficiency claims (scoped, deferred)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
BLOCKED_BY: 01
TOUCHES: (scoping only)

## Goal
"Reproducible or unpublished" ultimately implies a fixed, re-runnable eval set — observational
land logs are neither reproducible (every unit is a different task) nor variance-bearing at
today's volume. Scope what a committed, deterministic eval harness for harness×model×membrane
comparisons would look like (EAP's bench/ is the pattern: committed corpus, fixed tasks, honest
baseline arm, success reported next to tokens).

## Approach
Deferred deliberately (red team B, M1): do not build until concern 01's observational gate has
run against real post-G3 volume and shown where it stays "unpublished". Then decide: fixed task
corpus in-repo vs replaying a frozen sample of real landed units. This concern is a scoping
document, not code.

## Cross-Repo Side Effects
None.

## Verify
A written scope with a build/no-build recommendation, reviewed against 01's live data.
