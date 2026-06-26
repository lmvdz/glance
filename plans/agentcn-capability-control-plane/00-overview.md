# Agentcn-style capability control plane

STATUS: closed

## Scope

Deeply integrate agentcn-style source-owned recipes into `omp-squad` as production-grade, tenant-scoped capability packs. The target is a multi-tenant, federated, context-sharing control plane where recipes become first-class runtime capabilities, not manual config snippets.

## Scope table

| # | Concern | Complexity | TOUCHES |
|---|---|---|---|
| 01 | Capability manifest and source ingestion | architectural | `src/capabilities/*`, `src/types.ts`, `tests/capabilities-manifest.test.ts` |
| 02 | Tenant persistence, RBAC, and lifecycle APIs | architectural | `src/capabilities/*`, `src/dal/store.ts`, `src/db/*`, `src/server.ts`, `src/authz.ts`, `tests/capabilities-api.test.ts` |
| 03 | Install controller and runtime bindings | architectural | `src/capabilities/*`, `src/squad-manager.ts`, `src/types.ts`, `tests/capabilities-install.test.ts` |
| 04 | Runtime adapters for profiles/workflows/Flue/RPC | architectural | `src/capabilities/*`, `src/squad-manager.ts`, `src/workflow-catalog.ts`, `src/workflow-driver.ts`, `src/flue-service-driver.ts`, `src/rpc-agent.ts`, `src/agent-host.ts`, `tests/capabilities-runtime.test.ts` |
| 05 | Manifest-driven webapp capability UI | architectural | `webapp/src/lib/dto.ts`, `webapp/src/lib/api.ts`, `webapp/src/hooks/useSquad.ts`, `webapp/src/context/TaskContext.tsx`, `webapp/src/components/*`, `webapp/src/lib/*.test.ts` |
| 06 | Upgrade, diff, rollback, and verification records | architectural | `src/capabilities/*`, `src/server.ts`, `webapp/src/components/*`, `tests/capabilities-upgrade.test.ts` |
| 07 | Federated capability metadata distribution | architectural | `src/federation.ts`, `src/manager-registry.ts`, `src/server.ts`, `src/capabilities/*`, `tests/capabilities-federation.test.ts` |
| 08 | Federated context sharing and discovery surfaces | research | `src/context/*`, `src/fabric*`, `src/server.ts`, `src/capabilities/*`, `docs/*`, `tests/capabilities-context.test.ts` |

## Dependency graph

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | none | `CapabilityManifest` can validate an agentcn-style registry item from a fixture and reject unsupported runtime fields. |
| 02 | 01 | Manifest identity/checksum/state types exist; otherwise persistence schema will churn. |
| 03 | 01, 02 | Install records and RBAC APIs exist; otherwise bindings have no durable owner/lifecycle. |
| 04 | 03 | Binding model exists; otherwise runtime adapters cannot resolve enabled pack versions. |
| 05 | 02, 03 | APIs expose catalog/install/binding state; otherwise UI becomes mock state. |
| 06 | 02, 03, 04 | Packs can install and bind; otherwise diff/rollback has no real target. |
| 07 | 01, 02, 06 | Pack metadata is immutable/versioned and upgrades are safe; otherwise federation spreads unstable state. |
| 08 | 03, 07 | Installs and federated metadata exist; otherwise context policy lacks source/install identities. |

## Batch order

1. Batch 1: Concern 01.
2. Batch 2: Concern 02.
3. Batch 3: Concern 03.
4. Batch 4: Concern 04 and Concern 05 can run in parallel only after Concern 03 publishes binding DTO contracts. Concern 04 owns backend runtime fields; Concern 05 consumes DTOs.
5. Batch 5: Concern 06.
6. Batch 6: Concern 07.
7. Batch 7: Concern 08.

Estimated total batches: 7.

## Shared-file analysis

- `src/types.ts`, `src/squad-manager.ts`, and `src/server.ts` recur across backend concerns. Keep type/schema changes in Concern 01/02 first; later concerns import those contracts.
- `src/capabilities/*` is intentionally shared. Use one owner per batch: schema/source (01), persistence/API (02), install controller (03), runtime adapters (04), hardening (06), federation/context (07/08).
- Webapp changes should not edit legacy UI. Preserve the starter look and render capability data through new DTOs/components.

## Acceptance for the whole plan

- Org admin can add a trusted agentcn-style source, validate packs, approve/install/enable/disable a pack, and see audit history.
- Installed packs materialize real profiles/workflows/actions bound to immutable pack versions.
- Runtime execution uses existing `RpcAgent`, `WorkflowDriver`, and `FlueServiceDriver` seams.
- UI renders catalog/install/runtime state from manifests and install records without mock data or old dashboard components.
- Upgrades require manifest diffs and can roll back.
- Federation initially shares only capability metadata; context sharing is separate, explicit, redacted, audited, and opt-in.
