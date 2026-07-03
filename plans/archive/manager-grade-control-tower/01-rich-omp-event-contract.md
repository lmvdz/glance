# Rich OMP event + transcript contract
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/rpc-agent.ts, src/agent-driver.ts, src/server.ts, src/tui.ts, webapp/src/lib/dto.ts, webapp/src/lib/omp-thread.ts, tests/*, webapp/src/**/*.test.ts

## Goal

Stop flattening OMP/TUI-rich execution into bland text like `{"activity":"stage: Implement"}`. Preserve tool names, args, lifecycle status, result/output, duration, stage/task metadata, pending lifecycle, and stable ids in the existing `SquadEvent`/transcript spine.

## Approach

- Keep `SquadEvent.type === "transcript"` and mandatory `TranscriptEntry.kind/text/ts` for compatibility.
- Add optional rich fields to `TranscriptEntry`, not a second stream:
  - `id` / `seq` stable per manager append.
  - `clientTurnId` for optimistic user-message reconciliation.
  - `status?: "running" | "ok" | "error" | "cancelled"`.
  - `tool?: { callId?: string; name: string; args?: unknown; result?: unknown; partial?: unknown; isError?: boolean; durationMs?: number }`.
  - `format?: "markdown" | "command" | "stage" | "plain"` plus bounded command/stage detail when OMP exposes it.
  - `pending?: { requestId: string; action: "created" | "answered" | "cancelled" }`.
- Extend `ClientCommand.prompt` with optional `clientTurnId`; echo it into the appended user transcript entry.
- In `SquadManager.onAgentEvent`, handle `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` as one lifecycle keyed by `toolCallId` when the frame provides it. Do not parse TUI strings.
- Preserve richer `RpcSessionState` fields already polled by `applyState`: `todoPhases`, queued message count, compaction, thinking/steering/follow-up/interrupt mode, session id/name/file. Add compact optional `AgentDTO.session` / `AgentDTO.todoPhases` fields.
- Keep `append()` as the redaction chokepoint. Cap large args/results; store full unsafe data nowhere.
- Update TUI renderer to ignore unknown rich fields but show better labels for `format:"stage"` / tool status where cheap.
- Update web dto mirror in the same change.

## Cross-Repo Side Effects

None. Webapp is in the same repo but separate TS package; its dto mirror must stay aligned.

## Verify

- Fake driver test: repeated identical prompts with distinct `clientTurnId`s render as distinct transcript entries, no duplicate/triple echo.
- Fake frame test: `tool_execution_start → update → end` produces one coherent rich tool entry/replay and one receipt tool count.
- Fake pending test: UI request created/answered/cancelled updates `pending[]` and leaves a timeline entry.
- `subscribe` replay returns enriched entries equal to live WS emissions.
- Existing TUI `buildBoard()` still renders old minimal transcript entries.
