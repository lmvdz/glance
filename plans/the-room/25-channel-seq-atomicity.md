# Channel seq atomicity — the cursor's monotonic seq is allocated non-atomically

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/channels.ts (appendManager), src/dal/store.ts (DbStore/FileStore seq allocation), tests
BLOCKED_BY: none (01 landed; this is a defect in it)
MODE: afk

## Goal
Two channel appends that overlap in time must get distinct, monotonic seqs. Today they do not:
`ChannelStore.appendManager` reads `store.nextChannelSeq(channelId)` and then, **after three
further awaits**, inserts `seq + 1` — a read-modify-write with no lock and no atomic allocator
(src/channels.ts:131-155). Concurrency is the normal case, not an edge case: every unit event
projects fire-and-forget (`void this.projectUnitTranscriptEvent(...)`,
src/squad-manager.ts:11220), and #fleet is the default sink for every unbound unit in the org.

This defeats concern 01's own Verify line ("`?since=` returns exactly-once tail"), concern 08's
("WS drop/reconnect shows no gaps or dupes"), and the A-M1 cursor design that both rest on.

## Evidence (verified 2026-07-24, not inferred)
- **Live data, this repo's own fleet.** `~/.glance-room-fleet/channels.jsonl`: 532 entries in
  #fleet, **431 distinct seqs — 101 entries (19%) carry a seq already used by another entry**;
  one seq is shared by 6 entries. Every colliding entry is a `needs-you` card — the flagship
  door's kind.
- **DB mode is worse: the writes are lost, not just mis-ordered.** `channel_entries` has
  `addPrimaryKeyConstraint("channel_entries_pk", ["org_id","channel_id","seq"])`
  (src/db/migrations.ts:108). Five concurrent `appendManager` calls against a real DbStore:
  **1 persisted, 4 rejected with `UNIQUE constraint failed`**. `projectUnitTranscriptEvent`
  catches and `log("warn", ...)`s, so the card vanishes with only a daemon log line; a human
  post via `POST /api/channels/:id/entries` has no catch at all and 500s, losing the message.
- **File mode does not error, it silently truncates the cursor.** Same five calls all returned
  `seq: 1`. Cold load (`since=0`) still returns every row, so the loss only shows on the
  incremental path: after a WS drop the client asks `?since=N` and never receives any entry
  whose seq is ≤ N but which it never saw. That is the reconnect gap 08 promised to test.
- Repro (probe kept out of the tree; recreate in a scratch file):
  `Promise.all([1,2,3,4,5].map(n => channels.appendManager("fleet", {authorActor:"manager", text:`card ${n}`, event:{kind:"land-merge", payload:{n}}})))`
  → assert `new Set(entries.map(e => e.seq)).size === 5`.

## Product consequences
1. **DB mode drops proof cards.** "The room is the complete projection of system state" is false
   under any concurrent burst — precisely the multiplayer mode wave 4 is being built for.
2. **Dropped needs-you cards do not page the operator.** `maybePushAlert` fires off the
   `{type:"channel-entry"}` event, which is only emitted on a successful append
   (src/server.ts:3424, 3508) — a collided card means no push notification for that gate.
3. **A-C1 is defeated by a second mechanism.** Red team A killed JsonlLog because it destroyed
   irreplaceable human messages; the store-rows replacement destroys them too, one layer up, in
   the seq allocator.

## Approach
1. Serialize per channel inside `ChannelStore`: a per-channelId promise chain (the store is a
   singleton per SquadManager, i.e. per org per process), so allocate-and-insert is one critical
   section. This alone fixes every single-process case, which is all of file mode and today's
   DB mode.
2. Make the allocation atomic at the store seam rather than trusting the lock alone —
   `appendChannelEntry` should accept an entry *without* seq and return the persisted row, with
   DbStore allocating inside the same transaction as the insert (`max(seq)+1` under the
   transaction, or an explicit per-channel counter row) and FileStore allocating under the same
   in-process lock. Keep the retry: on a unique-constraint failure, re-read and retry with a
   bounded count (cross-process replicas can still collide).
3. Do not let a projection failure stay a `log("warn")`: on final failure after retry, count it
   (the honesty-tier discipline) so a dropped card is visible rather than inferred from a log.
4. Backfill is NOT in scope — existing colliding rows stay as they are; the cursor tolerates
   duplicate history because `since` is a `>` filter. Say so in the PR body rather than leaving
   it unstated.

## Cross-Repo Side Effects
None. `webapp` reads seq only for ordering/cursor and needs no change.

## Verify
- New test: N concurrent `appendManager` calls on one channel → N distinct, contiguous seqs, on
  BOTH FileStore and DbStore (the DbStore arm is the regression guard for the PK violation).
- New test: concurrent human post + manager projection → both persist, neither 500s.
- Reconnect test: append 5 concurrently, then `entries(channelId, since=<max seq before>)`
  returns exactly the new 5.
- `bun test` green with `node_modules/.bin` on PATH (tests/dal-store.test.ts,
  tests/channel-replies-search.test.ts, tests/projection-routing.test.ts).

## Notes
Filed 2026-07-24 out of a due-diligence review of this plan, not by a red team round: both
REDTEAM-A and REDTEAM-B reviewed the *design*, and the design never mentions write concurrency
— A-M1 specifies the seq as a cursor mechanism without ever saying who allocates it. The gap is
in the design's coverage, not in either red team's execution against it. Concern 18 (membership
fan-out) touches src/channels.ts and is in flight; sequence this after it lands or coordinate,
to avoid a same-file collision.
