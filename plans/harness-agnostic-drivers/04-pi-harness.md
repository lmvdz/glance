# pi harness — the offline plug-and-play proof
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/harness-registry.ts, src/agent-host.ts, src/squad-manager.ts

## Goal
Register **pi** (`@earendil-works/pi-coding-agent`) as a second harness through the new seam and
prove a unit runs end-to-end — demonstrating plug-and-play against a genuinely different binary
WITHOUT any new protocol (pi speaks the same `--mode rpc` LF-JSONL frame family as omp).

## Approach
- Register `pi`: `protocol: "omp-rpc"`, reusing the RpcAgent/agent-host transport with a pi command
  table entry `["pi","--mode","rpc","--cwd",cwd, ...]`.
- **Arg-table divergence** (verified via pi's rpc docs): pi uses `--approve`/`-a` / `--no-approve`,
  NOT omp's `--approval-mode <mode>`. The command builder in `src/agent-host.ts` (~:147-151) must be
  per-harness: omp emits `--approval-mode <mode>`; pi maps `yolo → --no-approve` (only yolo is
  allowed for pi per concern 03) and omits/adjusts accordingly. `--model` and `--thinking` and
  `--append-system-prompt` exist on pi with the same shape → pass through.
- **Capabilities** (concern 03): pi = `{ hostTools:false, toolApproval:"none", resumable: <same detached-host reattach as omp? verify>, modelSwitch:true, thinking:true, contextInjection:"native" }`. `hostTools:false` because pi has no `set_host_tools` channel (squad_message/squad_kb_search silently vanish otherwise).
- **omp-specific host extensions**: omp injects `PI_RPC_EMIT_TITLE=0` + `-e lease-hook.ts` (src/agent-host.ts:~153,162). Verify these load (or no-op cleanly) under pi; gate them to `protocol==="omp-rpc" && harness==="omp"` if they don't.
- Do NOT assume pi's frames are byte-identical — add a smoke that pi's `agent_start`/`message_update.assistantMessageEvent.text_delta`/`message_end.usage` parse through the existing `onAgentEvent` unchanged.

## Verify
- Unit (fake pi `--mode rpc` server, same wire as the omp fake): a pi-harness unit starts, prompts, streams a text delta, ends — parsed by the unchanged `onAgentEvent`.
- Unit: pi + `always-ask` rejected; pi + yolo builds `--no-approve`; host-tool advertisement skipped.
- **Live (if the pi binary is installable on this box)**: `GLANCE_HARNESS=pi` or `--harness pi`, spawn a real unit, confirm it completes a turn. If pi isn't installable, mark this harness `verified:false` per concern 08 and record the gap — the fake-server unit test still proves the seam.
