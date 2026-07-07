# DemandSignal model + durable queue
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/factory/queue.ts, src/capabilities/index.ts, src/dal/store.ts, src/automation-log.ts

## Goal
A typed, deduplicated, restart-durable queue of capability-shaped demands — without inventing a new persistence store. Each `DemandSignal` records what the fleet appears to lack, the evidence behind it, and a dedup key so the factory loop doesn't re-emit the same demand every tick.

## Approach
- Define `DemandSignal` in `src/factory/queue.ts`:
  ```ts
  type DemandKind = "proceduralize" | "fix-churn" | "profile-tune" | "unblock-collision";
  interface DemandSignal {
    id: string; kind: DemandKind; targetArea: string; // e.g. a path/module/agent role
    dedupKey: string;            // hash(kind + targetArea)
    evidence: DemandEvidence;    // provenance: which signal(s), values, sample runIds
    state: "open" | "drafting" | "proposed" | "dismissed";
    createdAt: number; updatedAt: number;
  }
  ```
- **Persist inside the existing capability snapshot** rather than a new store: the snapshot already round-trips through `src/dal/store.ts` (`body.capabilities`) and survives restart/cold-adopt for free. Add a `demands: DemandSignal[]` field to the capability snapshot shape and its `normalize` path in `dal/store.ts`. Keep the queue pure-function-mutated like the rest of `capabilities/index.ts` (`enqueueDemand`, `transitionDemand`).
- **Dedup:** `enqueueDemand` is a no-op if an `open`/`drafting`/`proposed` demand with the same `dedupKey` exists. This is the fix for the loop re-spawning identical work every tick.
- **Observability:** write demand enqueue/transition events to `src/automation-log.ts` (`automation.jsonl`, ring+spool) — not a new journal. The durable event journal (`plans/factory-control-plane/05`) is unbuilt; do not depend on it.

## Cross-Repo Side Effects
Capability snapshot shape gains a field — any consumer that structurally validates the snapshot (federation metadata, schema in `src/schema/`) must tolerate the new field. `Schema.Struct` strips excess by default, so confirm the demands field is declared where the snapshot is decoded.

## Verify
- Enqueue two demands with the same `(kind,targetArea)` → only one persists.
- Round-trip: enqueue → serialize via `dal/store.ts` → reload → demand survives with state intact.
- `automation.jsonl` shows a demand-enqueued event.
- `bun test` green.
