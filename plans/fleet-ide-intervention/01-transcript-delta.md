# I01 — incremental transcript delta

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/server.ts (the /api/agents/:id/transcript route), src/squad-manager.ts (getTranscript), tests
BLOCKED_BY: none

## Goal

`GET /api/agents/:id/transcript?since=<seq>` returns only the transcript entries with `seq > since`, so the cockpit's conversation pane (I03) can poll deltas every ~1.5s instead of refetching the whole transcript. Full transcript (no `since`) keeps working unchanged.

## Ground truth

- Today `GET /api/agents/:id/transcript` (`src/server.ts:1994`) returns `manager.getTranscript(id)` = the full `TranscriptEntry[]` (`src/squad-manager.ts:1959`), ignoring all query params.
- `TranscriptEntry` has a monotonic manager-local `seq` (`src/types.ts:146-167`) — the cursor already exists on the wire; no endpoint honors it.
- Incremental delivery currently exists ONLY as WS `type:"transcript"` push — unusable from the fork (CSP blocks ws://), hence the poll.

## Approach

- Extend the route: parse `?since=` (integer). If present and valid, return `getTranscript(id).filter(e => (e.seq ?? 0) > since)`; else the full array (back-compat). Keep it a pure filter over the in-memory array — cheap.
- Optional: add `getTranscriptSince(id, seq)` on the manager so the filter lives next to `getTranscript`, or filter in the route. Prefer the manager method for symmetry + testability.
- Response stays a bare `TranscriptEntry[]` (the client concatenates by `seq`, dedupes on `id`/`seq`). Document that entries without `seq` (legacy) sort last / are always included on a full fetch.
- Do NOT change the WS push or the full-fetch shape.

## Acceptance

- Unit test: `?since=N` returns only entries with `seq > N`; no param returns all; a bogus `since` (non-int) falls back to full (never 500s).
- Live (scratch-daemon): a unit with a few transcript entries — `GET .../transcript` returns all; `?since=<mid-seq>` returns only the tail; `?since=<max-seq>` returns `[]`.
