# Non-destructive restore/fork at turn granularity

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (fork() :5749, `git branch squad/<newId> <sha>` at :5771), src/worktree.ts (addWorktree :136, reused for scratch-worktree materialization), webapp/src/components/ (extend existing diff/steer UI, not a new renderer), src/server.ts (restore endpoint), tests/ (new)
BLOCKED_BY: 02

## Goal

Restore or fork from an arbitrary turn checkpoint (concern 02's `refs/glance/checkpoints/<unitId>/<turnN>`) WITHOUT ever blind-checking-out onto a tree a human might be actively touching. Extends the shipped never-lose-work fork precedent (`fork(id, {seq})` → `git branch squad/<newId> <sha>`, squad-manager.ts:5749/5771) to turn-ref granularity; restore is a distinct, new operation that materializes the ref into a scratch worktree and hands back a diff for pull/hunk-apply, never a direct write to the live tree.

## Approach

- **Extend fork() for turn-ref targets.** `fork(id, opts: {seq?})` (squad-manager.ts:5749) already resolves a checkpoint-log seq to a sha, cuts `git branch squad/<newId> <sha>` (:5771, guarded by the double-fork claim discipline at :771-773), and reuses `addWorktree`'s existing-branch checkout path (comment at :70). Add an alternate resolution path accepting a turn-ref (`unitId`/`turnN`) instead of a workflow seq — same branch-cut-then-addWorktree shape, new input, no change to the existing seq-based path (must not regress the shipped never-lose-work behavior).
- **Restore is NOT fork.** Fork makes a new independent, running unit. Restore answers "what did turn N look like" without creating a new unit or touching the live one:
  1. Resolve `refs/glance/checkpoints/<unitId>/<turnN>` (concern 02) to a commit sha. Fail closed if the ref is missing (concern 02's acceptance criterion — dependents refuse) or ambiguous.
  2. Materialize it into a NEW scratch worktree via `addWorktree` (src/worktree.ts:136), rooted at that sha. **Never** `git read-tree`/`checkout-index` onto the unit's LIVE worktree, and **never** `git reset --hard` on it either — this is the red-team A3 finding: the live tree is not a safe target for any restore operation, because a human or a running agent may be mid-edit on it at the exact moment restore executes.
  3. Diff the scratch worktree's materialized state against the unit's live worktree (current HEAD or working tree), reusing the existing diff machinery behind `GET /api/agents/:id/diff` (`worktreeDiffSinceFork`-style computation, per the shipped Intervene/DiffReviewPanel path) rather than building a second diff renderer.
  4. Present the diff for pull/hunk-apply. Nothing is auto-applied to the live tree — a human (or the unit's own next turn, if agent-initiated) chooses what to bring back, mirroring the shipped line-comment→steer interaction pattern (`commentSteer` → `diffLineSteerMessage` → `steerCommand`).
- **Explicit rejection, enforced not just documented:** no code path in this concern may run `read-tree`+`checkout-index`, `reset --hard`, or `checkout <ref> -- .` against a path that is a registered unit's live worktree. Since red-team A3 specifically found this failure mode (a concurrent hard-reset from another actor racing a restore), add a test that greps/spies on every git invocation this concern's code makes and asserts none of the destructive verbs above ever target a live-worktree path — only the scratch-worktree path may receive materialization commands.
- **Scratch worktree lifecycle:** inspection-only restores are ephemeral — remove the scratch worktree after the diff is computed and handed back (or after a bounded TTL if the UI keeps it open for interactive hunk-picking), following the same worktree-add/remove discipline as fork's worktrees, minus "keep forever."

## Cross-Repo Side Effects

none.

## Verify

- **Live-tree-never-touched test:** via a git-runner spy, assert that during a restore call no `read-tree`, `checkout-index`, or `reset --hard` command is issued with the live unit's worktree as `cwd` — only the scratch worktree path receives materialization commands.
- **Red-team A3 regression test:** simulate a concurrent actor `reset --hard`-ing the live worktree WHILE a restore is in flight; assert the restore's scratch worktree and resulting diff are unaffected (they operate on the ref's sha, independent of live-tree state) and the concurrent live-tree change is neither clobbered by restore nor silently lost.
- **No-regression test:** `fork(id, {seq})`'s existing workflow-checkpoint-log path (shipped in never-lose-work concern 04) continues to pass unchanged once the turn-ref extension lands alongside it.
- **Diff-accuracy test:** the diff returned by restore reflects the actual content delta between the checkpoint ref's tree and the live worktree's current state — a content-level assertion, not just "a diff object exists."
- All under `bun test`; git-write path, so cross-lineage review (codex + grok) applies per 00-meta.md's model-routing decision.
