# squad_worktree_inspect tool
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/console-tools/worktree-inspect.ts (new), src/console-tools.ts, tests/console-tools.test.ts

BLOCKED_BY: 01

## Goal
The console agent can answer "what did unit X actually change?" — the exact question that made the 2026-07-04 fleet answer shallow (ompsq-420's 'dirty worktree' was an unreviewable mystery to the chat; it was a 5-line fix).

## Approach
Registry entry `squad_worktree_inspect`, `readOnly: true`, parameters `{ agent: string (name or id), file?: string, mode?: "summary"|"diff" (default summary) }`.
Handler:
- Resolve agent via `manager.getAgent()` / roster name match; error politely if unknown or no worktree.
- `summary`: `changedFiles(worktree)` (`src/explore.ts:110`) + branch/ahead-behind (reuse whatever the DTO/land probe already computes — do not invent new git plumbing) → file list with status letters.
- `diff`: `worktreeDiff(worktree)` (`src/explore.ts:83` — handles nested untracked post-PR#31); if `file` given, only that entry. Caps: 4KB per file, 12KB total, "…truncated" markers.
- Works for uncommitted state AND committed-but-unlanded (mention `git log main..HEAD --oneline` inclusion if the explore helpers expose it cheaply; otherwise summary covers uncommitted only — state which in the tool description so the model doesn't overclaim).

## Cross-Repo Side Effects
None. Same exposure as the existing `GET /api/agents/:id/diff` (`src/server.ts:1275-1280`).

## Verify
- Tests: known-agent summary lists a seeded temp-repo's changed files; `file` filter; caps enforced; unknown agent → isError; agent without worktree → isError.
- Manual: ask the chat "what's in ompsq-<x>'s worktree?" and compare with the TaskDetail diff panel.
