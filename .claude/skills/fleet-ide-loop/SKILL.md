---
name: fleet-ide-loop
description: Autonomous one-concern-per-iteration goal loop for the fleet-first IDE meta-plan (plans/fleet-first-ide) — orient, select the highest-priority unblocked concern across the bridge/cockpit/later-epic sub-plans, implement it in the right repo (omp-squad worktree or the glance-desktop clone), gate, ship a draft PR, flip STATUS, append the ledger, schedule the next wakeup. Run under /loop ("run the fleet-ide loop", "keep the fleet-first IDE moving"). Do NOT invoke for one-off questions — it selects its own work, creates repos/branches, and opens PRs autonomously.
---

# Fleet-IDE goal loop

One landable concern per iteration, until `plans/fleet-first-ide/00-meta.md`'s epics are all done. Authorized scope: everything the meta-plan's Decisions section locks in (including creating the private `glance-desktop` repo in C01). The loop never merges.

## Iteration protocol

**1. Orient (cheap, every iteration).**
- Read `plans/fleet-first-ide/00-meta.md` (decisions, ledger tail) and the sub-plan overviews (`plans/fleet-ide-bridge/`, `plans/fleet-ide-cockpit/`, plus any later-epic dirs the loop has since created).
- `gh pr list` in omp-squad and (once it exists) glance-desktop: which loop PRs merged since last iteration? Flip their concerns `in-review → done` and unblock dependents. If >3 loop PRs sit unmerged, the report must hand Lars a ready `!`-prefixed merge loop and PREFER concerns not stacked on them.

**2. Select.** Highest PRIORITY, then lowest concern number, among concerns with STATUS: open and no unmet BLOCKED_BY (a blocker counts as met when its PR merged — not when opened, unless stacking is the only remaining work; say so in the ledger). Epic charters marked "charter only" whose expansion trigger is met: the iteration's work IS the expansion — run a /plan-quality decomposition against then-current code into a new `plans/fleet-ide-<epic>/` dir, ship it as the PR.

**3. Implement.**
- omp-squad concerns: fresh worktree (`EnterWorktree`), branch per concern. glance-desktop concerns: work in `~/sui/glance-desktop`, branch per concern (it's the loop's own clone — no worktree ceremony needed, but never work on main).
- Follow the concern doc's Approach and its "recon first" instructions literally; if reality contradicts the doc, update the doc in the same PR and say so.
- Model routing per the meta-plan Decisions: sonnet subagents for iterative in-repo implementation; codex for self-contained mechanical diffs; grok for wide read-only sweeps. Judgment stays here.

**4. Gate.** omp-squad: the repo's standard verification (bun test with node_modules/.bin on PATH — see test-PATH memory — plus targeted live verification the concern's Acceptance demands; scratch-daemon for daemon/webapp surfaces). glance-desktop: `pnpm build`, `pnpm vitest run`, `cargo check`, Biome; live-drive the Acceptance's UI proof under WSLg where possible. An Acceptance bullet that cannot be run gets reported as NOT RUN in the PR body — never as passed (absence-invariant memory).

**5. Ship.** Commit in logical groups, push, `gh pr create --draft` with the concern doc linked and Acceptance results (ran / result / not-run+why). Cross-lineage review (codex + grok) before opening the PR for anything touching trust, git-write, spawn, or hook-installation paths (B02, B03, C01 fall in this class).

**6. Close out.** Flip the concern's STATUS (`open → in-review`), append one ledger line to 00-meta.md (date, concern, outcome, PR URL) — these plan-file edits ride on the concern's own branch/PR when possible; otherwise a tiny follow-up commit on the meta branch. Report per background-session conventions with a `result:` line.

**7. Pace.** ScheduleWakeup dynamic: next wakeup 1200–1800s after a shipped iteration (Lars merges between iterations); 300–600s only when the next concern is already unblocked and independent. If EVERY remaining concern is blocked on unmerged PRs or a Lars decision, report `needs input:` with the exact unblock (usually the merge loop) and schedule a 3600s heartbeat.

## Stop conditions

- All epics done or descoped by Lars → append the final ledger line, report, and stop the loop (`ScheduleWakeup stop:true`).
- Two consecutive iterations produce no shippable progress for the same structural reason → `needs input:` with the reason; keep the heartbeat, don't thrash.

## Standing cautions

- Never merge, never push to main (either repo), never flip glance-desktop visibility, never enable public CI there.
- Bootstrap-order exception: C01 pushes the initial terax history to the new repo's main ONCE (that push IS the bootstrap); everything after goes through branches.
- The daemon runs the GLOBAL install — daemon-behavior verification needs the bounce discipline (bounce skill), and only a fresh pristine worktree counts as a gate run (ratchet-drift memory).
