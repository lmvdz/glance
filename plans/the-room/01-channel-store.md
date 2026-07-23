# Channel store — durable org-scoped channels with a durability split
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/channels.ts (new), src/dal/storage.ts, src/db (channel tables/migration), src/types.ts, src/server.ts (GET/POST channel endpoints), src/schema/http-body.ts, tests
MODE: afk

## Goal
Org-scoped channels exist as a first-class daemon primitive. Human-authored messages are durable
(DB rows via the storage seam in DB mode — the audit-table pattern, src/squad-manager.ts:6971-6981,
src/dal/storage.ts); a JsonlLog ring serves only as hot tail/cache. File mode: JSONL with rotation
disabled + awaited flush on graceful shutdown, honestly labeled best-effort (single-operator).
Channel entries reuse the TranscriptEntry envelope shape (kind/text/ts/status/format + event) so
existing typed-card renderers bind to either.

## Approach
1. `src/channels.ts`: ChannelStore per SquadManager (constructed like transitionLog at
   src/squad-manager.ts:1101-1104, rooted in the manager's org state dir). Channel = {id, name,
   createdAt, kind: "default"|"user"}; #fleet default channel auto-created.
2. Entry shape mirrors TranscriptEntry (src/types.ts:186-207) + channelId + authorActor + optional
   replyToId + per-channel monotonic seq. Entries born settled — never status:"running" (delta/settle
   invariant boundary, src/transcript-delta.ts:33-40; PR #216 class). Append-only, no in-place edits.
3. Durability: DB mode → channel + channel_entries tables through the storage seam; ring cache for
   hot reads. File mode → per-org channels.jsonl, rotation off, flush awaited on shutdown.
4. Cursor: `GET /api/channels/:id/entries?since=<seq>` and full-list endpoints; WS resync uses seq
   (A-M1). Fan-out via per-org broadcastTo ONLY (src/server.ts:3239-3253) — never global broadcast.
5. New redact chokepoint: ALL ingress (human posts included — humans paste secrets) through
   redact(); agent/unit-derived strings additionally neutralizeDelimiters (A-M3, digest.ts).
6. Authorship rule (A-S3): client-authored posts carry text only — the `event` field is stripped or
   rejected at the append chokepoint; only manager-side projection writes event-bearing entries.
   Ship the test alongside the born-settled test.
7. New SquadEvent arm `{type:"channel-entry", channelId, entry}` mirrored in webapp dto.

## Cross-Repo Side Effects
None. webapp dto mirror only in this concern; rendering is 07/08.

## Verify
- Scratch daemon: post a message → row in DB (or jsonl line), WS frame delivered to same-org
  client only (two-org leak test: second org's socket receives nothing).
- Restart daemon → full history returns (DB mode); file mode → history survives graceful shutdown.
- Client post carrying an `event` field → stripped/rejected; test asserts no client-authored
  event-bearing entry can exist.
- No channel entry ever has status "running" (test). `?since=` returns exactly-once tail.
- bun test green (node_modules/.bin on PATH).
