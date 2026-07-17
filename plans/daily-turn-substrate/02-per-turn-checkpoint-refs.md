# Per-turn checkpoint refs — generalize past kind:"workflow"

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (onAgentEvent agent_end case ~:6243, captureHeadSha :3371), src/workflow/checkpoint-log.ts (extend seq/torn-line-repair conventions, do not fork), src/worktree.ts (runGit/hardening pattern reference, addWorktree :136), new small module for the isolated-index ref cut (e.g. src/turn-checkpoint.ts), tests/ (new)

## Goal

The never-lose-work plan's "generalize past kind:workflow" follow-up: checkpoint capture today only exists for workflow-kind agents (src/workflow/checkpoint-log.ts, one line per node boundary). Every unit's every turn needs a checkpoint — a git ref capturing full turn state (uncommitted + untracked), cut at the same `agent_end` attach point every unit already passes through, fail-closed so anything depending on the ref refuses rather than silently proceeding when capture fails.

## Approach

- **Attach point:** `SquadManager.onAgentEvent`'s `agent_end` case (squad-manager.ts:6243 region — live code, already runs for every agent kind, not just workflow: it's where `finalizeRun`/`voicePushArmed` re-derivation happens per-turn today). Add an unconditional per-turn capture call here. This is a SEPARATE, additional capture from the existing workflow-kind-only one (squad-manager.ts:6061, inside the checkpoint listener path) — do not modify that path, add alongside it.
- **Capture mechanism** — isolated temp index so the ref cut never touches the agent's real working index (which may be mid-edit for the next turn, or read concurrently by a diff request):
  1. `captureHeadSha(worktree)` (squad-manager.ts:3371, already exists, best-effort non-throwing `git rev-parse HEAD`) for the parent commit.
  2. `GIT_INDEX_FILE=<tmp-path> git -C <worktree> add -A` — stage everything (tracked changes + untracked files) into the temp index only.
  3. `GIT_INDEX_FILE=<tmp-path> git -C <worktree> write-tree` → tree sha.
  4. `git -C <worktree> commit-tree <tree> -p <headSha> -m "checkpoint <unitId>/<turnN>"` → commit sha (no working-tree/index side effects — commit-tree never touches either).
  5. `git -C <worktree> update-ref refs/glance/checkpoints/<unitId>/<turnN> <commit-sha>`.
  6. Delete the temp index file in a `finally` — success or failure, it must never leak into `.git/` as debris across turns.
  - Follow src/worktree.ts's hardening discipline for every git invocation here: `GIT_HARDEN_ARGS`/`GIT_HARDEN_ENV`, `scrubbedSpawnEnv` (the "ponytail" comment at worktree.ts:19 — untrusted repo config can exec code via `core.fsmonitor`/`diff.external`/hooks/pager; every git-write path in this repo neutralizes that, this one must too).
- **turnN / seq discipline:** extend src/workflow/checkpoint-log.ts's existing conventions — its `seq` is a per-runId serialized append counter initialized from the file's own line count on first touch after a boot (no separate persisted counter to drift out of sync), and its `repairAndCountLines` already handles a torn trailing line from a crash mid-append. Reuse this logic (either by extending checkpoint-log.ts to accept non-workflow callers, or a structurally-identical sibling that calls the same repair/seq functions) rather than inventing a second parallel numbering scheme.
- **FAIL-CLOSED acceptance (binding, from arbitration §7):**
  1. If the ref-cut sequence fails at any step, raise an AttentionEvent (src/types.ts:111, non-blocking) — "checkpoint capture failed for turn N" — never silently continue as if the checkpoint exists.
  2. Any downstream lane that depends on the ref existing — boundary sync (plans/daily-onramp/03), restore/fork (concern 03 in this epic) — MUST verify the ref's actual existence (or a persisted "checkpoint ok" marker from this capture) before proceeding, and REFUSE rather than degrade silently if it's missing.
- Respect concern 04 (orphan sweep): this concern only cuts refs, it does not clean them up — sweep logic for refs left behind by deleted units is 04's job, not built here.

## Cross-Repo Side Effects

none — refs live in the managed worktree's own `.git`; no cross-repo write.

## Verify

- **"checkpoint fails ⇒ dependent action refused"** (binding acceptance test): inject a failure into the ref-cut sequence (e.g. a git-runner stub that fails `commit-tree`) and assert (a) an AttentionEvent is raised, (b) a downstream consumer (stand-in stub, or the real boundary-sync/restore call if landed by then) refuses rather than proceeding.
- Round-trip test: drive a real turn in a scratch worktree; assert `refs/glance/checkpoints/<unitId>/<turnN>` exists after `agent_end` and its tree matches the worktree's actual state (staged + unstaged + untracked) at capture time — not just HEAD.
- Isolation test: assert `git status` in the worktree is byte-for-byte unchanged (no accidental staging in the real index) after a checkpoint capture runs mid-session.
- Restart-survival test: seq/turnN numbering across a daemon restart mid-run reuses checkpoint-log.ts's boot-time line-count re-derivation — no separate persisted counter to drift.
- All under `bun test` (PATH gotcha applies — bare `bun test` needs `node_modules/.bin` on PATH).
