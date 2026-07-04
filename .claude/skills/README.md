# Agent recipe library

Distilled 2026-07-04 by mining all ~40 Claude Code session transcripts (~250MB JSONL, 5 parallel miners + 240 subagent transcripts) for recurring work shapes. Recipes are ranked by how often the shape recurred × how much manual babysitting it cost.

## Codified as skills (this directory)

| Skill | One-liner | Mined recurrence |
|---|---|---|
| `land-sweep` | Verify "merged" actually reached main; restack wrong-base PRs; harvest stranded branches + uncommitted worktree WIP; prove; sweep | all 5 miners, 8+ sessions — the #1 shape |
| `bounce` | Daemon restart + prove-new-code-is-serving, plus the "I don't see the change" staleness triage tree | 6+ sessions, 4 memory notes |
| `reality-audit` | plans × Plane × code-on-main three-way lie detector with adversarial verification | 4 sessions (one ran it as a 26-agent/1.74M-token ad-hoc workflow, then threw the script away) |
| `scratch-daemon` | Isolated throwaway daemon for live verification: boot/seed/drive/teardown + controlled pipeline dogfood + prove-preexisting | 6 sessions, ~10 spinups in one |
| `execute-plan` | Adversarial design panel → review-gated batches → audit gauntlet → stacked PRs → crash recovery (scripts in `references/`) | 6 workflow executions, 13/13 concerns shipped clean |
| `make-it-work` | (pre-existing) one lies→works fix per iteration, proven by running it | — |

## Proposed skills (worth writing when the shape next fires)

- **untangle-wip** — disentangle the shared main checkout's working tree into owned threads (mine vs foreign session/daemon WIP), hunk-level staging, zero-foreign-marker verification before commit. (5 sessions; near-miss: almost shipped foreign code.)
- **unit-autopsy** — on-demand diagnosis of one squad unit: worktree mtime/diff/commits vs concern TOUCHES (off-script detector), verify-contention, main divergence, transcript tail → healthy/thrashing/off-script/stalled + the escalation ladder (scope-locked re-dispatch from a task file → after 2 failures, direct in-harness implementation).
- **webapp-crash-triage** — minified stack/white-screen → symbol→component mapping → API-boundary shape-drift root cause → `normalize*`-at-data-boundary fix pattern (house style) → deploy + served-bundle-hash confirm. (Same crash class 4+ times.)
- **incident-fix** — two-track discipline: immediate live unblock now, permanent fix + regression test + draft PR always, recurrence stakeout when the cause can re-arm.
- **docs-truth-audit** — parallel code-ground-truth extraction (CLI/routes/env/defaults) + per-section staleness audit; verify every dubious claim against code (caught a fabricated command and an overclaiming commit).
- **safe-rebrand-sweep** — classify occurrences display vs functional (env prefixes, state dirs, security regexes, protocol ids); compat shims first; user-facing sweep only; treat string-assertion test failures as classifier feedback. (Fires again at the glance deep rename.)
- **design-mock-then-port** — reference imagery → interactive HTML artifact mock (cheap iteration, ~15 rounds observed) → checkpoint commit of mock+DESIGN.md as draft PR → backend slice + tests → renderer port → live verify. (Shipped Fleet Pulse.)
- **live-ui-goal-review** — build → scratch-daemon → screenshot key surfaces with real data → critique ranked worst-first against the product goal → fix with regression tests → re-click the actual flows.
- **third-party-integration-verify** — ground the API against the installed package's dist (never memory); pure testable core first; live-drive the whole protocol incl. tampered payloads; hand the user the one dashboard step you can't do.
- **transcript-mining-diagnosis** — partition the session archive by size across parallel miners, one question each, verbatim quotes + dated events; grounding agent builds designed-vs-documented reality; synthesize ranked diagnosis → BRIEF → /plan. (Produced the direct-vs-glance diagnosis and this very library.)
- **session-recover** — worktree sessions key transcripts to the worktree's project dir; copy into the main project dir; `/resume` needs the full UUID, not the 8-char job id.
- **goal-gap-loop** — the /loop body that works: parallel goal audits → rank by leverage → 1-2 scoped fixes with tests → prove failures pre-existing → ledger + memory → stop when only operator decisions remain, and present them.

## Proposed daemon capabilities / code work (file as Plane tickets, not skills)

- **land-watch** — `glance watch <unit|issue>`: branch tip + landReady + automation log → fire on land/stall/fail with the reason; guards against the observed false positives (matching your own filing commit; stale watchers; timeout ≠ landed).
- **gate-sitter** — operator-side gate loop: poll for gates, surface plan docs, answer via the command API, detect dead-at-gate processes (frozen lastActivity) → restart then re-answer.
- **stranded-WIP consolidator** — daemonized `land-sweep` phase 2/3: the observer's `auditStrandedUncommitted` (shipped in PR #39) finds it; nothing yet harvests it automatically.
- **cross-agent invariant audit** — after multi-agent batches: verify each earlier agent's load-bearing invariants survived later rewrites (sibling of race-reviewer in the capability catalog).

## Proposed hooks (via /update-config)

- **push-integrity** (PostToolUse on `git push`) — `git ls-remote origin <branch>` SHA must equal local HEAD; rtk-summarized output once hid 6/8 failed pushes. Highest-stakes near-miss in the corpus.

## Cross-cutting boilerplate for every fan-out prompt

1. rtk mangles bash grep/gh/git output — Read/Grep tools or `rtk proxy`; distrust null results.
2. `PATH="$PWD/node_modules/.bin:$PATH" bun test`; the 2 WSL spawn flakes are pre-existing.
3. Absolute paths / repo-root cwd for gates (`cd` residue broke suites twice).
4. Big reports → file + pointer (notifications truncate).
5. Detached processes: separate exports + `nohup … &`; kill by port, not name.

## Top systemic pain points the recipes exist to kill

1. Merge-world integrity: MERGED ≠ on main (wrong-base stacks, never-pushed work, units-never-commit) → `land-sweep`, stacked-PR rules in `execute-plan`.
2. Fix-invisible-after-ship: global-install symlink, unbuilt dist, cache-pinned shell, service workers, stale tokens → `bounce`.
3. Status stores lie in every direction → `reality-audit`.
4. Shared checkout + shared sockets as collision zones → `scratch-daemon`, untangle-wip.
5. Tooling that lies (rtk mangling, swallowed pushes, truncated notifications) → boilerplate above + push-integrity hook.
