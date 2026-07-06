# Exception-triggered steering lane (stalled row → steer)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/insights.ts, webapp/src/lib/agent-control.ts, webapp/src/components/AttentionPanel.tsx, webapp/src/lib/insights.test.ts

## Goal (what is built)

A "Needs you" row that fires when a working agent goes quiet (drift signal), whose one action is
**Steer** — redirecting the live unit mid-flight with a fresh prompt turn. Trigger is activity-staleness
per DESIGN.md D3.

## Approach (how — cite real file:symbol attach points you verified)

- `webapp/src/lib/insights.ts:435` `AttentionActionKind` — add `'steer'`. `:434` `AttentionKind` — add `'stalled'`.
- `webapp/src/lib/insights.ts:474` `attentionItems`, inside the `for (const a of agents)` loop (`:483`). After the `landReady` branch (`:536`), add a branch: if `a.status === 'working' && a.lastActivity && Date.now() - a.lastActivity > STALL_MS` (module const `STALL_MS = 15 * 60_000`, matching DESIGN.md D3), push `{ id:`stalled:${a.id}`, severity:'warn', kind:'stalled', title:`${a.name} has gone quiet`, detail:'No activity for a while — it may be stuck or drifting. Steer it back on track.', agentId:a.id, since:a.lastActivity, action:{label:'Steer', kind:'steer'} }`. Guard with the existing `seenAgentKinds`/`mark` dedupe pattern (`:479`) so it never doubles a blocked/error row.
- `webapp/src/lib/agent-control.ts:114` — add `export function steerCommand(agentId: string, message: string): ClientCommand { return { type: 'prompt', id: agentId, message }; }` (modeled on `answerCommand` but with NO `clientTurnId` — a fresh steering turn, not a pending answer; the `{type:'prompt'...}` shape is verified at `dto.ts:509`).
- `webapp/src/components/AttentionPanel.tsx:134` `onAction` — add `case 'steer':` that opens the existing inline composer (`setAnswering(item)` at `:138`) reusing the Answer textarea (`:246`); `submitAnswer` (`:102`) branches on `item.action?.kind === 'steer'` to send `steerCommand(...)` instead of `answerCommand(...)` and toast "Steer sent". (The composer already has `agentId`; steer needs no `requestId`, so relax the `submitAnswer` guard at `:103` to allow a missing `requestId` when the kind is `steer`.)

## Verify (concrete command + expected observable outcome)

`cd /home/lars/sui/omp-squad/.claude/worktrees/meta-plan-autonomous-fleet && bun test webapp/src/lib/insights.test.ts` — new case: an agent `{status:'working', lastActivity: Date.now() - 20*60_000}` yields exactly one item with `kind:'stalled'` and `action.kind:'steer'`; a fresh working agent yields none. Then in the running webapp, let a working agent idle past the threshold, click **Steer** on its row, type a redirect, send — confirm the text lands as a new user turn in that agent's live transcript (console).

## Scope boundary (what NOT to touch)

Do not add a server endpoint — `{type:'prompt'}` already routes through the live WS `ClientCommand`
path (`applyCommand`, `squad-manager.ts:3243`). Do not touch confidence, reports, or the daemon.
Steer never interrupts or kills — it only injects a prompt turn.
</content>
