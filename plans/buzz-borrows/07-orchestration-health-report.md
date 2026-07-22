# Orchestration health report over real-usage stores
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src (small read-only report module or CLI subcommand), .claude/skills (optional runbook), tests
MODE: afk

## Goal
A repeatable orchestration-quality signal — land rate, rejection reasons, steer count per landed unit, dispatch→land wall clock — computed from the stores real usage already populates. Buzz built a synthetic benchmark harness (harbor-buzz-orchestra); design review reshaped ours: synthetic fixtures rot (REGRESSION_GATE precedent — executed once, daemon died after C01) and the scratch-daemon rig has a live-contamination scar, while the land-assessment store already records every attempt/rejection/landed terminal and transitions.jsonl every lifecycle edge from 1,700+ real land attempts of history. Measure reality first.

## Approach
1. A read-only report (CLI subcommand `glance orch-report` or a small module behind an endpoint) over: src/land-assessment/store.ts events + snapshots (month-sharded), transitions.jsonl, and audit entries for steer counts. Windowed (e.g. --since 30d), per-repo and fleet-wide rollups.
2. Metrics: attempts, land rate, rejection-reason histogram, median dispatch→land wall clock, steers-per-landed-unit (needs-you proxy). Output: plain text + JSON (JSON in/out per the repo's agent-first CLI conventions).
3. Persist nothing new; the report is derived. If run on a cadence later (dogfood-drain could embed it), that's a one-line addition to the drain skill.
4. Explicitly deferred (recorded in 00-overview): synthetic fixture benchmark on scratch-daemon — only if the real-usage signal proves too confounded, and then with mandatory fresh-`git init`/mkdtemp fixture repos (never a live worktree, per the scratch-daemon contamination scar).

## Cross-Repo Side Effects
None.

## Verify
- Run against a state dir with known land-assessment history → numbers match a hand-count on a small fixture window.
- Runs with land-assessment flag historically off → degrades to transitions-only metrics with a clear "partial data" note, exit 0.
- `bun test` green; no write path touched (grep assertion: report module imports no writers).
