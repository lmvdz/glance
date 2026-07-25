# The node object and its channel binding
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts (new), src/channels.ts, src/dal/store.ts, src/db/migrations.ts, src/db/schema.ts, tests
MODE: afk

## Goal
One object type that represents a piece of work at any depth — plan, unit, subagent, landing — with a
parent link, state, owner, and a lazily-created channel. Everything else in this plan is a view over it.

## Approach
1. `Node { id, parentId?, kind, title, state, ownerId?, createdAt, settledAt?, channelId? }`. One type
   with a parent link, not three special cases — the interaction is identical at every depth.
2. `channelId` is nullable and populated on FIRST message. A node can always host a conversation; it
   only has one once someone speaks. Pre-creating channels per node makes a 100-node tree 97 dead rooms.
3. Nodes inherit their channel's membership. Do NOT add a second visibility model — concern 18 already
   owns this, and two models that can disagree about who may read what is the exact bug class fixed in
   PR #252 (`visibleAnswer` vs `canReadAgent`).
4. Migration: existing agents become nodes with `kind: "unit"`; existing channels keep working
   unchanged. Legacy rows with no node binding read as root-level, the same way concern 18's legacy
   channel rows read as org-public.
5. Both stores. `FileStore` and `DbStore` parity is not optional — every membership test in the suite
   was FileStore-only until PR #249 and that gap hid real defects.

## Cross-Repo Side Effects
None.

## Verify
- A node tree round-trips through both stores; parent links survive a restart.
- A node with no messages has no channel row; posting one creates it exactly once under concurrency.
- A non-member cannot read a node whose channel is private — asserted per store.
- Migration over an existing state dir: agents become unit nodes, no channel is lost.
