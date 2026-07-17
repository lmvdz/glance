# Host-tools over docker-exec (SandboxAgentDriver.setHostTools)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 06
TOUCHES: src/sandbox-agent-driver.ts, src/squad-manager.ts, tests/sandbox-host-tools.test.ts (new)
MODE: afk

## Goal
A sandboxed agent gets its host tools (e.g. `squad_record_decision`) — today they silently vanish.

## Approach
`setHostTools` exists only on `RpcAgent` (`rpc-agent.ts:432`); the manager calls it with optional chaining
`rec.agent.setHostTools?.(tools)` (`squad-manager.ts:7504`), so under `SandboxAgentDriver` it no-ops silently —
the exact "never-called set_host_tools" silent-degradation class this repo already fixed once.

The transport already exists: `SandboxAgentDriver` speaks omp's docker-exec JSONL frame protocol
(`decodeHostToolCall` is imported and handled). Implement `setHostTools` on the driver by sending the same
host-tools frame over the existing exec stdio channel that `RpcAgent` sends over its socket. This is a port, not
new protocol.

## Cross-Repo Side Effects
None.

## Verify
- A sandboxed agent receives a host-tool grant and can invoke `squad_record_decision` (drive it against a scratch
  daemon; the frame round-trips).
- Mutation proof: a test asserting the host-tools frame reaches the sandboxed agent goes red if `setHostTools` is
  removed from the driver.
- No silent no-op path remains: `setHostTools` is defined on every driver that can carry tools, or rejects loudly.
