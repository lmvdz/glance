# Store → five per-lane backend types (type-only)
STATUS: done
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

## Done (2026-08-12, round 3 iteration 11 — PR #378)
Exactly as designed: five lane interfaces (Snapshot/Audit/ChannelBackend/GraphBackend/
Governance), Store = the extends-intersection, FileStore/DbStore + the factory untouched;
consumers narrowed to their quarters (ChannelStore's two genuine graph methods and NodeStore's
legacy-migration load() declared honestly via Pick). The cheap fix landed bigger than filed:
26 inline NodeRecordStore constructions (16 of them silently swallowing validation warnings)
became one field with one logger. Both lineages FULLY delivered and came back clean — 36/36
signature parity verified independently twice; NodeRecordStore proven stateless so the
singleton is behavior-identical; zero constructions missed. RECORDED DEBT (codex): NodeStore's
load() edge exists for the one-time legacy state.agents migration — moving that to store
startup would make NodeStore purely graph-backed; a candidate note for the review round.
Gates: check 0, caller suites 84/84, root 5332/2-inherited, webapp untouched (type-only +
daemon-only changes).
