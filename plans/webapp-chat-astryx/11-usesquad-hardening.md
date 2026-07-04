# useSquad reconnect + transcript-window hardening
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/hooks/useSquad.ts, webapp/src/hooks/useSquad.test.ts (new or extend existing)

## Goal
A WS reconnect resumes every subscribed transcript (not just the last one), and cap-eviction can no longer reorder a still-streaming entry — prerequisites for trusting the scroll-lock UX (a frozen region looks identical to an idle agent).

## Approach
Red-team findings, both in `webapp/src/hooks/useSquad.ts`:
1. **`subscribedRef` is a single slot** (`:84`, set at `:174-177`), and on WS reopen only that one id is re-subscribed (`:111-112`). With the chat panel and TaskDetail embeds watching different agents, a reconnect silently freezes all but the last. Change to `Set<string>`: `subscribeConsole(id)` adds; re-subscribe loops the set on reopen; add an `unsubscribeConsole(id)` (or prune on agent removal) so the set doesn't grow stale ids that re-subscribe forever.
2. **Cap-eviction reordering** in `appendTranscriptEntry` (`:61-70`): when the 800-cap has evicted an entry and a late upsert for its id arrives, the id-match fails and the entry is appended at the END — out of order. Fix: if the entry's id is absent AND the window is at cap AND the entry is older than the window's head (compare `seq` if present, else timestamp), drop it instead of appending.

## Cross-Repo Side Effects
None (server already tolerates repeated subscribe commands — it just replays).

## Verify
- Unit tests (pure parts): the append/upsert/drop decision extracted or tested through the exported helper — id-upsert in place; new entry appends; stale-evicted upsert drops; cap slides correctly.
- Manual: subscribe chat to agent A and TaskDetail to agent B; kill the WS (dev-tools offline toggle or daemon restart); on reconnect both transcripts resume growing.

## Resolution
`subscribedRef` converted to a `Set<string>` with reconnect re-subscribing every entry, plus `unsubscribeConsole` to prune stale ids; `appendTranscriptEntry` now drops stale-evicted upserts instead of appending them out of order. Covered by `useSquad.test.ts`.
