# C03 — rebase protocol

STATUS: open
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: mechanical
TOUCHES: UPSTREAM.md, scripts/upstream-drift.sh (new), GitHub Actions workflow (weekly, private repo)
BLOCKED_BY: C01

## Goal

Upstream merges dozens of PRs a week; without a mechanism the fork rots in a month. A weekly drift check + documented rebase runbook keeps the additive-only discipline honest and makes divergence a decision, not an accident.

## Approach

- `scripts/upstream-drift.sh`: fetch upstream, report commits-behind, files upstream touched that WE also touch (the conflict forecast — `git diff --name-only origin/main upstream/main` ∩ our changed-files list), and whether `src/modules/fleet/` neighbors changed.
- Weekly GitHub Action runs it and opens/updates a single "upstream drift" issue with the report (no auto-rebase — a human or the loop rebases deliberately).
- UPSTREAM.md runbook: rebase steps, the conflict-forecast reading, the escape hatch (if a rebase costs > a day, record why; two such events = bring the hard-divergence decision to Lars per meta-plan).

## Acceptance

- Script runs locally with correct counts against a deliberately stale checkout; Action green on the private repo; runbook complete enough that a fresh session could execute a rebase from it alone.
