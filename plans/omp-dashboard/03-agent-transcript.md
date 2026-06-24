# Agent detail + live transcript
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/ws.ts, webapp/src/hooks/useSquad.ts, webapp/src/components/agent/*

## Goal
Select an agent → a detail pane with a header (status/model/branch/repo, todo, context%) and the
**live transcript** (user/assistant/thinking/tool/system) streaming in real time.

## Approach
- **Transport** — extend `lib/ws.ts` + `useSquad`: on select, `send({type:"subscribe", id})`
  (`ClientCommand`, `types.ts:479`); accumulate `transcript` events (`TranscriptEntry` `types.ts:49`)
  into `Map<agentId, TranscriptEntry[]>`; **re-send `subscribe` for the open agent on WS reopen**.
  `snapshot` already replays recent transcript.
- **Transcript view** — render by `kind`: `assistant` prose (markdown), `thinking` dimmed, `tool`/
  `system` mono, `user` accented. Auto-scroll to bottom unless the user scrolled up; virtualize when
  long (ponytail: cap to last N until it measurably matters). `messageCount` drives cheap diffing.
- **Header** — `AgentDTO` fields: status pill (`agentColorVar`), model, branch, repo, todo
  (`done/total`), `contextPct` bar, `activity`, `etaAt`.

## Cross-Repo Side Effects
None. Extends the shared `useSquad`/`ws.ts` (later concerns build the action bar onto this detail).

## Verify
- Subscribe to a `working` agent → entries append live; thinking/tool/assistant render distinctly.
- Switch agents → transcript swaps to the newly-selected agent.
- Kill the WS (stop/restart the daemon) → on reconnect the open agent re-subscribes and resumes.
