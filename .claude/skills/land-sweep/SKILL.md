---
name: land-sweep
description: Reconcile git/GitHub truth with what actually reached main — verify "merged" PRs really landed, restack wrong-base stacked PRs, harvest stranded committed branches and uncommitted worktree WIP, land it all as proven draft PRs, then sweep the debris. Use when the user asks "what needs to be PR'd and merged", after any fleet run, before trusting a MERGED badge, or when worktrees pile up.
---

# land-sweep — nothing is landed until main contains it

The single most-repeated failure shape in this repo's history (mined from ~40 sessions, 2026-07): work that everyone believed shipped but that never reached main. Three flavors, all real incidents:

1. **Wrong-base stacked merges** — PRs #27/#34/#35 showed MERGED but were merged into their *parent branches* (`docs/full-overhaul`, `feat/lifecycle-truth`, `feat/never-lose-work`), not main. Tell: stack children merged seconds apart (`mergedAt` within ~1 min) without base retargeting.
2. **Never-pushed execution** — PR #26 merged the research+plan; the 18 execution commits happened later in the worktree and were never pushed.
3. **Units-never-commit** — squad units finish the work and leave it as *dirty files* in their worktree (OMPSQ-403/411/417..425 pattern). 0 commits ahead; the diff is the deliverable.

## Phase 1 — inventory (read-only)

- `git fetch origin` first. Then: `git worktree list`, `gh pr list --state open/merged` (via `rtk proxy` — the rtk cache serves stale PR state), `ls plans/`.
- For every local branch: `git cherry origin/main <branch> | grep -c '^+'` → patch-unique count. Anything >0 is a suspect.
- For every "merged" PR that matters: `gh pr view N --json baseRefName,mergeCommit` then `git merge-base --is-ancestor <mergeCommit> origin/main`. **base != main or NOT-ancestor ⇒ the merge never reached main.**
- Patch-ids lie after rebases — always confirm with a **content-level spot check**: `git ls-tree origin/main <signature-file>` for a file the branch created.
- For every squad/agent worktree: `git -C <wt> status --porcelain` count + `rev-list --count origin/main..HEAD`. Dirty + 0-ahead = stranded-uncommitted candidate.

## Phase 2 — triage the dirty worktrees (subagent)

Fan a subagent over the dirty worktrees. For each: what is the WIP, and is it **already on main** (compare working-tree content against origin/main's version of the file, not against the worktree's stale HEAD)? Verdicts: ALREADY-LANDED (discard) / STRANDED-VALUABLE (harvest) / JUNK. Consolidation commits (e.g. an operator's earlier hand-sweep) commonly cover several units' WIP — expect duplicates and drop dup hunks at harvest time.

## Phase 3 — land

Work in an isolated worktree. Per body of stranded work:

- **Wrong-base restack**: branch from the tip that contains everything (the deepest child's merged head), `git merge origin/main`, resolve, PR to main.
- **Stranded branch**: branch from its tip, merge origin/main. When both sides added code at the same insertion point (e.g. a guard landed on main where the branch adds another guard), the resolution is almost always **union — keep both**.
- **Uncommitted WIP**: capture with `git -C <wt> add -N . && git -C <wt> diff` (add -N includes untracked), apply with `git apply --3way` onto a fresh branch, one commit per ticket, drop hunks that conflict because main already has them.
- Run the FULL suite per branch before pushing: `PATH="$PWD/node_modules/.bin:$PATH" bun test` (bare bun test fails 2 spawn tests). Push, open **draft** PRs with the why (which lie this fixes), the merge-resolution notes, and the suite count.

## Phase 4 — prove and sweep

- After the user merges: re-fetch, verify every PR's merge commit is an ancestor of origin/main AND every source branch is 0 cherry-unique. Run the full suite **on merged main** — the PRs were only ever tested against the main that existed when each was opened.
- Sweep: archive every dirty worktree's final diff to a dated dir (`~/sui/.omp-squad-swept-<date>/`), back up any branch with unique commits to `refs/swept/<date>/<name>` (`git update-ref`) before `git branch -D`. Remove worktrees with `git worktree remove --force`. **Never mass-delete remote branches without explicit user say-so.**
- Correct any memory/STATUS/Plane claims the sweep falsified ("shipped on PR #N" when it never reached main). A lie left in memory re-arms the incident.

## Gotchas that cost real time

- rtk mangles `gh pr list` (empty-looking), grep, and `git log` ordering — use `rtk proxy` and distrust null results.
- After `git push`, verify: `git ls-remote origin <branch>` SHA == local HEAD (rtk once swallowed 6 of 8 failed pushes).
- Suites from a worktree need `bun install` first; run them `run_in_background` and read the tail, never chain after a long command.
