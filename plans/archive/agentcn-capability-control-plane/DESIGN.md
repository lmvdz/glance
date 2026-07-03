# Design: agentcn-style capability control plane

## Approach

Build a first-class **Capability Pack** layer inside `omp-squad`, modeled on agentcn's source-owned recipe registry but integrated with our existing tenancy, runtime, federation, and web control plane.

A pack is not a dependency we import at runtime. It is a versioned, checksum-pinned source bundle with manifest metadata. Installing it for an org produces tenant-scoped bindings into existing `omp-squad` primitives: agent profiles, workflows, runtime adapters, tools/skills, docs/previews, context-sharing policy, and audit records.

Core split:

- **CapabilityPack**: immutable recipe content and metadata. Answers: what is this capability?
- **CapabilityInstall**: org-scoped approval and lifecycle state. Answers: which tenant approved what version?
- **CapabilityBinding**: materialized runtime links. Answers: what profile/workflow/tool/driver/UI action did this install enable?
- **CapabilityContextPolicy**: explicit import/export rules. Answers: what context may this capability publish or consume locally/federated?

This keeps agentcn's durable idea — installable, inspectable recipes you own — while preserving `omp-squad` as the multi-tenant/federated control plane.

## Landscape

Relevant current seams:

- `src/manager-registry.ts` already creates one `SquadManager` per org with per-org `stateDir`, worktree base, and store. Capability installs should live under this boundary.
- `src/auth.ts` / `src/authz.ts` provide RBAC at REST and manager command chokepoints.
- `src/squad-manager.ts` has env-driven profiles via `profileOptionsFromEnv`, agent creation, feature creation, workflow spawning, Flue/RPC/runtime driver dispatch.
- `src/workflow-catalog.ts` exposes static workflow definitions and live workflow runs.
- `src/workflow-driver.ts`, `src/flue-service-driver.ts`, `src/rpc-agent.ts` are runtime targets.
- `src/federation.ts` is an inert-but-present seam for cross-operator presence, commands, team chat, and leases.
- `src/dal/store.ts` gives file and DB persistence behind one `Store` interface.
- `src/server.ts` centralizes tenant-resolved `/api/*` routes.
- `webapp/` is now a Vite starter-look UI with daemon data adapters under `webapp/src/lib/*`, `webapp/src/hooks/useSquad.ts`, and `webapp/src/context/TaskContext.tsx`.
- agentcn research found: registry compiler, source-owned recipe manifests, shadcn registry JSON, live typed preview events, manifest-driven install UX, llms/openapi/well-known discovery.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Pack model | First-class immutable CapabilityPack + mutable CapabilityInstall/Binding | Catalog-only metadata; federation-first graph | Catalog-only drifts from runtime. Federation-first overbuilds before local install semantics are proven. |
| Runtime execution | Bind packs into existing drivers (`RpcAgent`, `WorkflowDriver`, `FlueServiceDriver`) | New recipe runtime | Avoids a parallel execution engine and preserves current transcript/federation/audit paths. |
| Tenancy | Install state is org-scoped and stored through current per-org manager/store boundary | Global mutable config | ManagerRegistry already gives physical isolation. Use it. |
| Permissions | Manifest permissions are requests; org admins approve concrete grants | Trust recipe declarations | Recipes are supply-chain inputs. Default deny is required. |
| Federation | Publish metadata first; context sharing only via explicit policy | Auto-share pack outputs | Capability metadata is low risk. Context egress is sensitive. |
| UI | Manifest-driven catalog/actions inside the new starter look | Port old dashboard or agentcn site | User explicitly wants the new UI look preserved. |
| Upgrades | Stage new version beside old version, diff, approve, atomically switch bindings | Floating latest | Runtime/audit must be pinned to immutable versions. |

## Capability Contract

```ts
interface CapabilityPack {
  id: string;
  sourceId: string;
  framework: "omp" | "workflow" | "flue" | "external";
  slug: string;
  version: string;
  checksum: string;
  schemaVersion: string;
  title: string;
  description: string;
  files: CapabilityFile[];
  profiles?: CapabilityProfileSpec[];
  workflows?: CapabilityWorkflowSpec[];
  tools?: CapabilityToolSpec[];
  skills?: CapabilitySkillSpec[];
  requiredEnv?: string[];
  preview?: CapabilityPreviewSpec;
  ui?: CapabilityUiSpec;
  context?: CapabilityContextDeclaration;
  compatibility: { ompSquad: string; drivers: string[] };
}

interface CapabilityInstall {
  id: string;
  orgId: string;
  packId: string;
  version: string;
  state: "imported" | "validated" | "approved" | "enabled" | "disabled" | "failed" | "removed";
  approvedBy?: string;
  overrides: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface CapabilityBinding {
  id: string;
  installId: string;
  type: "profile" | "workflow" | "tool" | "skill" | "driver" | "ui-action" | "preview";
  key: string;
  sourcePath?: string;
  enabled: boolean;
  config: Record<string, unknown>;
}
```

The exact TypeScript names can change during implementation, but these boundaries should not.

## Risks

| Concern | Severity | Resolution |
|---|---|---|
| Remote recipe supply chain becomes executable input | critical | Checksum/signature/provenance fields, schema validation, dependency allowlists, default-deny tool grants, install audit. |
| Tenant isolation leaks through shared pack state | critical | Store install state under org scope; bind runtime through `ManagerRegistry`; add isolation tests for org A/B. |
| Federation leaks context | critical | Metadata-only by default; context egress requires `CapabilityContextPolicy`, redaction, retention, allowlists, and audit. |
| Profiles/workflows conflict with env-configured profiles | significant | Origin/precedence fields; no silent overwrite; UI shows install id/source/version. |
| UI becomes a hidden source of truth | significant | UI renders manifest + install state only; all changes through APIs. |
| Adapters become a new runtime | significant | Keep adapters as translators into existing drivers and workflow catalog. |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| A deep registry can accidentally bypass RBAC by becoming “configuration” instead of a user action. | critical | Every source/import/install/enable/run/federate route gets explicit REST tier and audit event. Runtime commands still pass manager command RBAC. |
| Version drift makes audit useless. | critical | Runtime bindings reference pack id + version + checksum. Floating latest is never executable. |
| Federation before local lifecycle creates a distributed consistency problem. | significant | Federation is split into metadata distribution first, context sharing later. Local install lifecycle ships before remote subscribe/run. |
| Installed source can rot after upstream updates. | significant | Add diff/upgrade/rollback concern before federation; old versions remain addressable while any install references them. |
| Capability source files might not map cleanly to current `omp`/workflow/Flue surfaces. | significant | Validation reports unsupported fields; adapters are explicit and fail closed. |

## Implementation Phases

1. Manifest schema and source ingestion.
2. Tenant-scoped persistence, RBAC APIs, and audit.
3. Install controller and binding materialization.
4. Runtime adapters into profiles, workflows, Flue, and RPC.
5. Manifest-driven web UI catalog/install/run surfaces.
6. Upgrade/diff/rollback and verification hardening.
7. Federation metadata distribution.
8. Federated context sharing and machine-readable discovery.

## Open Questions

None blocking decomposition. Implementation can refine exact DB table/file layouts while preserving the pack/install/binding/policy split.
