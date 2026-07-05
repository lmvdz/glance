# Non-blocking report primitive (squad_report host tool → report row)

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, webapp/src/lib/dto.ts, webapp/src/lib/insights.ts, webapp/src/components/AttentionPanel.tsx

## Goal (what is built)

A `squad_report` host tool an agent calls to say "I'm unsure — here's a proposed diff/summary" WITHOUT
stopping. It responds to the agent immediately, appends to a per-agent report channel (separate from the
blocking `pending` array — DESIGN.md D2), and surfaces a `warn`/`report` "Needs you" row with a View
action.

## Approach (how — cite real file:symbol attach points you verified)

- `src/types.ts` — add `export interface AgentReport { id: string; summary: string; proposal?: string; confidence?: number; createdAt: number; }`. On `AgentDTO` (`:483`) add `reports?: AgentReport[];` near `pending` (`:544`). Do NOT reuse `PendingRequest` / do NOT add a `source:"report"` (DESIGN.md D2 — pending is load-bearing for blocked status).
- `webapp/src/lib/dto.ts` — mirror `AgentReport` and add `reports?: AgentReport[];` to the mirror `AgentDTO` (field block ~`:331`).
- `src/squad-manager.ts:175` — add `const REPORT_TOOL = "squad_report";`. `:184` `SQUAD_HOST_TOOLS` — append a def (name `REPORT_TOOL`, params `{ summary: string (required), proposal?: string, confidence?: number }`, description: non-blocking "raise a proposal / flag uncertainty without stopping").
- `src/squad-manager.ts:4684` `onHostTool` — add `if (call.toolName === REPORT_TOOL) { void this.handleReportTool(rec, call); return; }` BEFORE the tool-grant gate at `:4696` (same exempt-and-early position as `PEER_MESSAGE_TOOL` at `:4689`).
- New `handleReportTool` modeled on `handlePeerMessageTool` (`:4748`) — the NON-blocking template: parse `summary`/`proposal`/`confidence`, push an `AgentReport` onto `rec.dto.reports` (create array if absent), append a transcript note ("📝 report: …"), call `rec.agent.respondHostTool(call.id, "report recorded")` immediately (agent keeps running), `this.emitAgent(rec)`. Never call `setPending` (that would block — DESIGN.md D2).
- `webapp/src/lib/insights.ts:474` `attentionItems`, in the agent loop (`:483`) — after the stalled/land branches, for each `r of a.reports ?? []` push `{ id:`report:${a.id}:${r.id}`, severity:'warn', kind:'report' (add to AttentionKind at :434), title:`${a.name} raised a proposal`, detail:r.summary, agentId:a.id, since:r.createdAt, action:{label:'View', kind:'view'} }`. `view` is an existing `AttentionActionKind` (`:435`) already wired to `openConsole` in `AttentionPanel.onAction` (`:150`) — no new action plumbing.
- `webapp/src/components/AttentionPanel.tsx` — no `onAction` change needed (View reused); optionally show `r.proposal` in the row detail.

## Verify (concrete command + expected observable outcome)

`cd /home/lars/sui/omp-squad/.claude/worktrees/meta-plan-autonomous-fleet && bun test webapp/src/lib/insights.test.ts` — new case: an agent with `reports:[{id:'r1',summary:'unsure about X',createdAt:Date.now()}]` and `status:'working'` (NOT `input`) yields a `kind:'report'`, `severity:'warn'` row AND the agent's status/`effectiveMode` are unaffected (proving non-blocking). Then in a running daemon, have an agent call `squad_report({summary:"...",proposal:"..."})`, confirm the tool returns immediately (agent's next turn proceeds, status never flips to `input`), and the proposal appears as a "Needs you" warn row.

## Scope boundary (what NOT to touch)

Do not touch `pending`, `blockedReason`, `derive`, or `setPending` — a report must never block. Do not
persist reports to state.json (live/run-scoped, like `receipt`). Auto-emit-on-low-confidence is leaf `06`.
</content>
