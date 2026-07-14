# Per-tenant socket directory
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/agent-host.ts, src/state-dir.ts, tests/socket-dir-scoping.test.ts (new)
MODE: afk

## Goal
One tenant's agent-host control sockets are not reachable by another tenant's processes through a shared global
directory.

## Approach
`squadSocketDir()` is a single global `<resolveStateDir()>/sockets` with no org scoping (`agent-host.ts:52-58`)
— unlike the worktree base, which *is* org-scoped in DB mode (`<stateRoot>/orgs/<orgId>/worktrees`). Any process
running as the daemon uid can `readdir` the socket dir and `Bun.connect` to a sibling's socket, then write raw
frames (`{"type":"prompt",...}`, `{"__sq":"shutdown"}` — `agent-host.ts:212-231`) into another tenant's agent.

- Namespace the socket dir by org in DB mode: `<stateRoot>/orgs/<orgId>/sockets`, mirroring the worktree base.
- `chmod 0700` the socket dir.
- File mode / single-org keeps the flat dir (no behavior change for the solo operator).

Note: a properly sandboxed agent can't reach the socket dir anyway (docker-exec stdio, no socket in the
container). This closes the host-path exposure — defense-in-depth beneath the sandbox, and the live boundary for
today's unsandboxed default.

## Cross-Repo Side Effects
None.

## Verify
- DB mode: two orgs' agent-host sockets resolve to different, `0700` directories; org A cannot enumerate org B's.
- File mode: socket path unchanged (assert the solo path is untouched).
- Existing agent-host reconnect/adopt tests still pass (the daemon reconnects to its own org's sockets).
