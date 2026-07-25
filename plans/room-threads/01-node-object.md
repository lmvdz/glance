# The node object and its channel binding
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts (new), src/channels.ts, src/dal/store.ts, src/db/migrations.ts, src/db/schema.ts, tests

## EXTENDED 2026-07-25 (RECONCILE finding 1) — associated records

The merged `Node` — one `parentId`, one `ownerId`, lifecycle state, goal, timestamps, `channelId` —
is materially too narrow for what the design decided. It cannot carry rule provenance, instruction
readings, decision alternatives and consequences, human authority, parked or stall evidence, evidence
age, the handover chain, retention fidelity, or the immutable delegation class.

The governing rule: **extend through ASSOCIATED RECORDS, never by overloading optional fields onto
`Node`.** `Node` answers "what is this piece of work". The records answer "what do we know, who said
so, and when". Their lifetimes differ — a node settles, its evidence outlives it — and a node with
thirty optional fields, most null, tells you nothing about which of them were ever populated.

`src/node-records.ts` defines nine kinds — rule, delegation-boundary, instruction-readback, objection,
plan-motion, evidence, human-authority, handover, retention — as effect Schemas, with the TypeScript
types derived from the schemas rather than written beside them. That is not a style preference: the
first version declared interfaces and hand-wrote a per-kind reader, and the reader silently dropped
every field it forgot. A withdrawn rule round-tripped as withdrawn with no withdrawal time and no
pointer to what replaced it — a rule that cannot say when it was taken back is not reversible in the
sense concern 11 requires. Deriving the type from the schema makes that class of drift impossible.

Fail-closed everywhere, because absence of evidence is the recurring defect in this codebase:

- A rule settles an action only when it is active AND names that action in `settles`. An earlier
  version returned true whenever any active rule existed on the node, so one rule about reversible
  changes authorised everything else on it.
- No rule reaches the non-delegatable class, whatever it names (concern 12).
- An objection with no falsifiable prediction is refused at creation (concern 14).
- An evidence claim with no sample size is refused (concern 18).
- A record that does not decode whole is dropped whole, never half-read.

FileStore and DbStore parity is asserted byte-for-byte, with migration `0015_node_records` and its RLS
companion.

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
