# Design: harness-agnostic, plug-and-play unit runtime

## Outcome
Run omp-squad units on any coding-agent harness — omp, pi, claude-code, codex, opencode,
gemini-cli (mastra-code as a follow-on) — behind one driver seam, selected by config, with each
harness's capabilities known and gracefully degraded when absent.

## Approach
omp-squad already has the right seam: `AgentDriver` (`src/agent-driver.ts`) with 5 implementations,
selected by a hardcoded `makeDriver` if-chain. This **finishes a started design** rather than
building greenfield. The work is: turn the if-chain into a registry, make the binary/harness
configurable (the `bin` field exists but is never populated), replace `runtime === "acp"` string
checks with a capability model, prove a real second harness end-to-end (**pi**), then harden the
ACP driver into the universal on-ramp for the four ACP-reachable harnesses.

An adversarial pass (designer → 2 red teams → arbiter) reshaped the draft in two decisive ways.

## Key decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| **Vocabulary** | **Keep omp-as-vocabulary (Option B).** Drivers translate their native protocol INTO omp's frame/state shape behind the single `src/types.ts` re-export of `RpcSessionState`/`RpcExtensionUIRequest`. | A: full ACP-modeled neutral redesign (omp becomes a translator). C: "owned neutral types structurally copying omp's". | Red team proved `RpcSessionState` is a **deep omp-owned type tree** (`Model`, `ThinkingLevel`, `TodoPhase`, `ContextUsage`, `AgentSessionEvent`), not a flat bag. C pays A's full blast radius (fork the whole nested tree) only to enshrine omp's *semantics* (phased todos, compaction/steering modes) as the "neutral" contract — worst of both. The ACP driver already translates into omp's shape today and it works. Revisit neutral types only when a second **non-ACP** protocol demands it. |
| **Seam axes** | Split into **transport × protocol**, keyed by a first-class `harness`. Sandbox is a protocol-aware **transport decorator**. | Flat registry keyed by harness alone. | `SandboxAgentDriver` is a full omp-RPC client over `docker exec` stdio — "run harness X in a container" only works for X=omp. sandbox×harness is a matrix. v1 scopes sandbox to omp and **rejects `sandbox + non-omp` at create()** with a clear error rather than silently building a broken driver. |
| **Migration** | Normalize `harness = p.harness ?? runtimeToHarness(p.runtime) ?? "omp"` at the single `makeDriver` choke point; add `harness` to `AgentDTO`. | Read `p.harness` raw. | Old on-disk records have `runtime:"omp"|"acp"`, no `harness`. Without the alias, every persisted ACP unit silently respawns as omp on daemon restart. |
| **Capabilities** | Explicit `CapabilityDescriptor` per harness `{hostTools, toolApproval, resumable, modelSwitch, thinking, contextInjection}`; replace all `runtime==="acp"` string checks with capability checks; degrade gracefully. | Duck-typing only (`if (driver.method)`). | Some capabilities have no 1:1 method (tool-approval, context-injection). A no-approval harness (pi) must be **rejected at create() unless yolo**, not silently coerced. |
| **Scope / phasing** | **Phase 1 (foundation + pi) ships and is fully offline-verifiable. Phase 2 (ACP tier) is gated per-harness on live binaries.** | One "Foundation + full ACP tier" plan. | The ACP tier depends on third-party binaries untestable in CI AND has two unsolved architectural blockers (below). Bundling makes the whole plan only as done as its least-verifiable harness. pi needs no new protocol, so pi-through-the-seam **proves plug-and-play against a real second binary, offline.** |
| **Honesty** | Unverified harnesses **hidden behind `OMP_SQUAD_UNVERIFIED_HARNESS=1`**, not merely flagged. Only a live smoke against the real binary flips `verified:true` — a green fake-server test does not. | List all harnesses with a `verified:false` flag. | Listing harnesses that half-work recreates this repo's core `/make-it-work` sin (things that "exist but don't work"). |

## Risks / unsolved blockers (Phase 2, made explicit — not TODOs)

- **ACP has no system-prompt slot** (verified against the ACP schema — neither `initialize` nor
  `session/new` accepts instructions/systemPrompt). omp-squad's profile memory, **tool-grant
  capability scoping**, and the **cold-start fabric primer** ALL ride `appendSystemPrompt`. So an
  ACP unit today runs with none of them. Decision deferred to a Phase-2 concern: v1 declares
  `contextInjection:"none"` (loud, honest); the real fix routes context through an **MCP server**
  via `session/new`'s `mcpServers` (the only spec-blessed channel).
- **ACP agents have no reattach.** `AcpAgentDriver` is a direct `Bun.spawn` child, not a detached
  host over a socket like `RpcAgent`. A daemon restart orphan-kills every ACP unit and loses
  mid-flight work. Phase-2 concern: mark ACP `resumable:false` and exclude from the reattach/adopt
  path (or accept the loss explicitly) — decided before shipping, not after a restart eats a unit.
- **"One ACP driver, four harnesses" is really "one driver + a per-harness quirk table."** Framing
  (newline-delimited) and permission kinds (`allow_once|allow_always|reject_once|reject_always`) are
  spec-settled (close those ponytails), but `claude-agent-acp` and `codex-acp` are third-party shims
  over unstable backends (codex-acp mid-migration). `pickOption`'s `options[0]` fallback on a
  kind-less option is a fail-open coin-flip → **must fail closed (reject)**.
- **pi caveats**: streaming path is a genuine bin-swap (same frame family), but pi uses `--approve`
  not `--approval-mode`, has **no host-tool channel** (`squad_message`/`squad_kb_search` silently
  vanish → `hostTools:false`), and omp's `PI_RPC_EMIT_TITLE`/`lease-hook.ts` extension may not load.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| Option C is worst-of-both (deep type tree, enshrines omp semantics as "neutral") | critical | **Dropped C. Keep Option B** + single re-export boundary; grep all direct `@oh-my-pi/*` type imports and route through `./types.ts`. |
| `harness` migration silently respawns ACP units as omp on restart | significant | Normalize at the one `makeDriver` choke point; migration test with a `{runtime:"acp"}` fixture; add `harness` to `AgentDTO`. |
| sandbox×harness is a matrix; generic-sandbox unbuildable for ACP | critical | v1: sandbox = omp-only; **reject `sandbox+non-omp` at create()**. transport×protocol split makes the matrix expressible later. |
| pi no-approval → silent full autonomy for attended units | significant | Reject non-yolo `approvalMode` at create() for `toolApproval:"none"`; surface `harness`+`toolApproval` on DTO; force-sandbox posture noted (deferred with sandbox×non-omp). |
| ACP drops appendSystemPrompt/primer/scoping (no ACP sysprompt slot) | critical | Phase-2 concern: `contextInjection:"none"` v1 + MCP-server route as the real fix. Not shipped pretending it applies. |
| ACP agents die on daemon restart (no reattach) | significant | Phase-2 concern: `resumable:false` + exclude from reattach path. |
| "one driver four harnesses" / kind-less permission fail-open | significant | Per-harness quirk table; `pickOption` fails **closed**; codex-acp gated unverified. |
| "pi near-free" overstated | significant | Re-scoped: `--approve` arg entry + `hostTools:false` + lease-hook check (~a day). |
| Listing unverified harnesses recreates the "exists but doesn't work" sin | significant | Hidden behind `OMP_SQUAD_UNVERIFIED_HARNESS=1`; only live smoke flips `verified`. |

## Open questions
None blocking Phase 1. Phase 2's context-injection route (contextInjection:"none" vs MCP-server) is
itself a concern to decide with a live ACP binary in hand.
