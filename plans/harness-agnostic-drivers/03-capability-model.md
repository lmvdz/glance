# Capability model + graceful degradation
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/harness-registry.ts, src/squad-manager.ts, src/types.ts

## Goal
Give every harness an explicit `CapabilityDescriptor`, replace all `runtime === "acp"` string checks
with capability checks, and degrade gracefully (never silently coerce or silently no-op).

## Approach
- `CapabilityDescriptor = { hostTools: boolean; toolApproval: "native"|"none"|"preauth-allowlist"; resumable: boolean; modelSwitch: boolean; thinking: boolean; contextInjection: "native"|"none"|"mcp" }` on `HarnessDescriptor`. omp = all-true/native. (ACP + pi values set by concerns 04/05.)
- Replace `registerHostTools`'s `if (rec.options.runtime === "acp") return` (src/squad-manager.ts:5054-5061) with `if (!rec.capabilities.hostTools) return` (belt-and-suspenders: also `rec.agent.setHostTools?.`). Grep for every other `runtime === "acp"` / `runtime ===` check and convert.
- **Graceful degradation rules**:
  - `toolApproval:"none"` (pi): **reject at create()** unless `approvalMode === "yolo"`, with a clear error ("harness <x> has no approval channel; only yolo is supported"). Do NOT silently coerce to yolo. Surface `harness` + `toolApproval` on `AgentDTO` so the UI never renders "always-ask" over a harness that can't ask.
  - `hostTools:false`: skip `set_host_tools` advertisement (squad_message/squad_kb_search unavailable — documented, not silent).
  - `contextInjection:"none"`: appendSystemPrompt/primer/scoping not applied — flagged at create (concern 06 owns the ACP resolution).
- **Reject `sandbox + non-omp-harness` at create()** with a clear error (sandbox×non-omp is Phase 3; today's SandboxAgentDriver only speaks omp-rpc). This closes red team's "silently broken driver" hole.
- ACP driver may narrow its static descriptor after `initialize` negotiation (concern 05) and emit a "capabilities resolved" event; the static descriptor is a ceiling.

## Verify
- Unit: creating a pi unit with `approvalMode:"always-ask"` throws the clear error; with `"yolo"` succeeds. Creating any non-omp harness with `sandbox` throws.
- Unit: `registerHostTools` skips advertisement when `hostTools:false`; no `runtime==="acp"` string checks remain (`grep -c 'runtime === "acp"' src/` → 0).
- DTO carries `harness` + capability summary. `bun run check` + `bun test` green.
