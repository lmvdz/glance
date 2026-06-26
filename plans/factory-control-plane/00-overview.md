# Factory-inspired control plane

STATUS: open

## Scope

Borrow Factory/Droid's useful operating-layer patterns for `omp-squad` without cloning Factory: explicit autonomy, proof-before-land, replayable sessions, and milestone workflow integration.

| # | Concern | Complexity | Touches |
|---|---|---|---|
| 01 | Fresh proof and land invariant | architectural | `src/proof.ts`, `src/land.ts`, `src/squad-manager.ts`, `src/server.ts`, `src/types.ts` |
| 02 | Serialized verify and land orchestration | architectural | `src/orchestrator.ts`, `src/orchestrator-state.ts`, `src/scheduler.ts`, `src/types.ts` |
| 03 | Canonical autonomy mode contract | architectural | `src/types.ts`, `src/squad-manager.ts`, `src/server.ts`, `src/index.ts`, `src/tui.ts`, `webapp/src/lib/dto.ts`, `webapp/src/components/*` |
| 04 | Driver capabilities and proof runner boundary | architectural | `src/agent-driver.ts`, `src/rpc-agent.ts`, `src/agent-host.ts`, `src/acp-agent-driver.ts`, `src/sandbox-agent-driver.ts`, `src/agent-guard.ts`, `src/lease-hook.ts`, `src/proof.ts` |
| 05 | Durable event journal for replay | architectural | `src/types.ts`, `src/dal/store.ts`, `src/sessions.ts`, `src/squad-manager.ts`, `src/server.ts` |
| 06 | Workflow milestone integration | mechanical | `src/workflow/*`, `src/workflow-driver.ts`, `src/features.ts`, `src/server.ts`, `webapp/src/lib/dto.ts` |

## Dependency graph

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | none | `proofGate` and `land()` can be read independently today. |
| 02 | 01 | Fresh proof/land invariant exists; otherwise locks serialize the wrong state. |
| 03 | 01, 02 | Proof state and verify/land locks exist; otherwise `autodrive` semantics are incomplete. |
| 04 | 03 | `autonomyMode` and mode admission exist; otherwise capability checks have no policy input. |
| 05 | 03 | Mode/proof transitions are defined; otherwise journal schema will churn immediately. |
| 06 | 03, 05 | Workflows can inherit mode/proof fields and emit journal events. |

## Batch order

1. Batch 1: Concern 01.
2. Batch 2: Concern 02.
3. Batch 3: Concern 03.
4. Batch 4: Concerns 04 and 05 may run in parallel only if ownership of `src/types.ts` changes is assigned to Concern 05 first; otherwise run sequentially.
5. Batch 5: Concern 06.

Estimated total batches: 5.

## Shared-file analysis

`src/types.ts`, `src/squad-manager.ts`, `src/server.ts`, and `src/proof.ts` overlap across concerns. Keep Concern 01 first because it fixes the unsafe land invariant. Keep Concern 03 before capability/journal work because it defines the mode vocabulary. If executing in parallel, give `src/types.ts` ownership to the autonomy/journal concern and pass the final contract to other agents.
