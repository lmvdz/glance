# ACP reattach posture (daemon-restart survival)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/harness-registry.ts

## Goal
Decide and enforce what happens to ACP units on daemon restart. `AcpAgentDriver` is a direct
`Bun.spawn` child (not a detached host over a socket like `RpcAgent`/`agent-host`), so today a
restart orphan-kills every ACP unit and loses mid-flight work.

## Approach
- Mark ACP harnesses `resumable: false` (concern 03 descriptor) and **exclude them from the
  reattach/adopt path** (reconnectLive/adoptOrphanedAgents in src/squad-manager.ts) so a restart
  doesn't try (and fail) to reconnect them, and doesn't cold-adopt a dead ACP process.
- Surface the non-resumability at create/UI ("this harness does not survive a daemon restart").
- Bigger alternative (deferred): put ACP agents behind the same detached-host indirection as
  RpcAgent, or use ACP `session/load` where the harness advertises the `loadSession` capability
  (capability-gated, not guaranteed) — a Phase-3 upgrade, not this pass.

## Verify
- Unit: an ACP unit is skipped by the reattach/adopt path on a simulated restart (no orphan-kill
  attempt, no cold-adopt); an omp unit still reattaches.
- The capability descriptor + DTO reflect `resumable:false`.
