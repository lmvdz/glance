# Driver capabilities and proof runner boundary
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/agent-driver.ts, src/rpc-agent.ts, src/agent-host.ts, src/acp-agent-driver.ts, src/sandbox-agent-driver.ts, src/agent-guard.ts, src/lease-hook.ts, src/proof.ts
PLANE: OMPSQ-309 — https://app.plane.so/inkwell-finance/browse/OMPSQ-309/

## Goal

Stop pretending every runtime has the same safety boundary. Mutating modes require declared capabilities, and proof execution must not inherit daemon trust.

## Approach

- Add driver capability reporting: guarded file ops, command policy, sandbox profile, network policy, approval support, replay support.
- Refuse or downgrade `assist`/`autodrive` when a driver cannot satisfy required capabilities.
- Keep leases as advisory conflict signals unless the driver/policy can enforce them daemon-side.
- Run proof/merge gates with minimal environment, no daemon secrets, scoped cwd, optional network-off sandbox, resource limits, and allowlisted command source.
- Ensure auto-resolve/helper processes are either guarded or explicitly excluded from `autodrive`.

## Cross-Repo Side Effects

None.

## Verify

- Add tests for capability admission: ACP or unguarded driver cannot enter `autodrive` unless capabilities say it can.
- Add a proof-runner test that sensitive daemon env is not visible to proof commands.
