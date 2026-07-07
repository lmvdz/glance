# Deferred (documented, not built this pass)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: (none — decision record)

## Goal
Record what is deliberately out of scope so it isn't re-proposed as a gap.

## Deferred items
- **mastra-code bridge.** mastra-code has NO ACP and no wire protocol (open upstream issue #14646).
  It's embeddable only as a Node `createMastraCode()`/`runMC()` library call. Integration = a small
  Node bridge process that imports mastra-code in-process and re-emits its `MCRun` events +
  `ResolutionPolicy` callbacks as `--mode rpc`- or ACP-shaped JSON over stdio. A separate concern.
- **sandbox × non-omp harness.** `SandboxAgentDriver` is an omp-RPC client over `docker exec` stdio;
  sandbox×harness is a matrix, not a list. Sandboxing an ACP harness needs `docker exec` speaking ACP
  (the ACP protocol layer over the sandbox transport) — exists in zero drivers. v1 rejects
  `sandbox + non-omp` at create() (concern 03). The real fix = a transport×protocol refactor
  (transport base + omp-rpc/acp protocol mixins) so containment composes with any harness.
- **WorkflowDriver inner-harness pluggability.** `WorkflowDriver` wraps an inner driver hard-wired to
  omp `RpcAgent`. Letting a workflow graph's agent nodes run on a non-omp harness is foreclosed by
  the kind-before-harness resolution order. A deliberate v1 boundary, not an accident.
- **Neutral-vocabulary redesign (Option A).** Only revisit if/when a second NON-ACP protocol demands
  it. Until then omp stays the internal vocabulary (Option B) behind the single `src/types.ts`
  re-export; new drivers translate into it. See DESIGN.md.

## Verify
n/a — decision record.
