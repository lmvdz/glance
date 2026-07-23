# glance open — fleet→worktree jump

STATUS: done — PR #178 merged, branch patch-equivalent to main; verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/index.ts (CLI subcommand), src/server.ts (endpoint), src/config.ts, webapp (unit card/detail button), tests
BLOCKED_BY: none

## Goal

`glance open <unit>` (CLI) and an "Open worktree" button in the webapp resolve a unit's worktree path and launch the operator's configured editor/cockpit on it. This is the suite's core gesture: fleet altitude → ground altitude in one action.

## Approach

- CLI: `glance open <unit-id|branch>` resolves the unit's worktree path from the daemon (reuse whatever the TUI uses to display worktrees; do not re-derive), then spawns the configured opener.
- Opener config (`src/config.ts`): `GLANCE_OPEN_CMD` template, e.g. `terax {path}` / `code {path}` / `wezterm start --cwd {path}`. Default resolution order: `terax` on PATH → `code` on PATH → print the path. `{path}` substitution only — no shell interpolation of unit-controlled strings (spawn with arg array, never a shell string).
- WSL2 gotcha (this host): if the opener is a Windows executable (`terax.exe`, `code`), translate the path via `wslpath -w` first; detect by the resolved binary's location under `/mnt/`. Cover with a unit test on the translation decision, live-verify on this machine.
- Daemon endpoint `POST /api/units/:id/open` (operator capability, same auth tier as steer): spawns server-side — only meaningful when daemon and display share a host; return the resolved path in the response either way so remote webapp clients can copy it. Refuse in DB/org multi-tenant mode (same doctrine as voice-token mint: no server-side process spawns on shared tenants).
- Webapp: button on the unit detail view; on 403/remote it falls back to copy-path + a hint.

## Acceptance

- Unit tests: path resolution, opener resolution order, arg-array spawn (no shell), wslpath branch, multi-tenant refusal.
- Live on this host: `glance open <some-unit>` opens the worktree in an editor; webapp button drives the same endpoint (scratch-daemon).
