# Store → five per-lane backend types (type-only)
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/dal/store.ts 177–226 (30 members), consumers: ChannelStore / NodeStore / NodeRecordStore / squad-manager
MODE: afk

## Goal
The facades already exist — ChannelStore/NodeStore/NodeRecordStore exclusively own 18 of 30
members. Split the INTERFACE only: SnapshotStore & AuditStore & ChannelBackend & GraphBackend &
GovernanceStore; Store stays as the intersection, FileStore/DbStore keep `implements Store`
(symmetry preserved, manager-registry factory untouched); consumers narrow to their quarter.
Test fixtures shrink from 30-method fakes to 7–11. Deletion test proves the diagnosis: delete
the name Store and nothing breaks — a bag, not a module.
INCLUDED CHEAP FIX: `new NodeRecordStore(this.store)` is constructed 26× inline in
squad-manager with inconsistent warn loggers — make it a field beside nodeStore/channelStore.

## Provenance
Round-2 review, daemon agent, rank 3, Strong.
