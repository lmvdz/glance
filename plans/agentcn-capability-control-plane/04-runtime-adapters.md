# Runtime adapters for profiles/workflows/Flue/RPC
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `src/capabilities/*`, `src/squad-manager.ts`, `src/workflow-catalog.ts`, `src/workflow-driver.ts`, `src/flue-service-driver.ts`, `src/rpc-agent.ts`, `src/agent-host.ts`, `tests/capabilities-runtime.test.ts`
PLANE: OMPSQ-324 — https://app.plane.so/inkwell-finance/browse/OMPSQ-324/

## Goal

Make enabled capability bindings executable through existing runtime seams.

## Approach

- `ProfileAdapter`: merges enabled capability profile bindings into `manager.profiles()` with visible origin and install id. Env profiles still work.
- `WorkflowAdapter`: projects capability workflow bindings into workflow catalog definitions and `WorkflowDriver` creation.
- `FlueAdapter`: maps Flue recipe bindings to `FlueServiceDriver` service configs under org-scoped dirs.
- `RpcAgentAdapter`: supports manifest-derived appended instructions/profile config when spawning `RpcAgent` sessions.
- `ToolSkillAdapter`: resolves declared tools/skills to approved runtime grants. Manifest declarations are requests, not permissions.
- All runtime invocations carry pack id/version/checksum into DTO/session metadata so transcripts/audit explain what capability ran.

## Cross-Repo Side Effects

If Flue worker source is installed into org state dirs, update docs for where source lives and how it is backed up.

## Verify

`bun test tests/capabilities-runtime.test.ts`

The test must prove enabled capability profiles/workflows appear in existing API outputs, disabled installs disappear, runtime creation references immutable pack version/checksum, and denied tools cannot run.
