# Data plane — pluggable Store over the DAL
STATUS: todo
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/dal/store.ts, src/squad-manager.ts

## Decision

Split manager state into **DB-backed control-plane data** (small, queryable, the multi-tenant
ledger) and **on-disk per-org blobs** (large, append-heavy). Thread the DB through a small
`Store` seam so the manager never imports the DAL directly:

| State | DB mode | File mode | Why |
|---|---|---|---|
| roster (agents) | `roster_index` table (authoritative) | `state.json` | small; admin/lazy "does this org have a fleet?" without booting the manager |
| features | `features` table | `state.json` | small, queryable |
| **audit** (mutations, auto-supervise, lands) | `audit` table | (none today) | the security trail P3 leans on; **currently unwritten** |
| usage (per-run ledger) | `usage` table | `receipts/` only | queryable cost/token ledger |
| transcripts | disk `state.json`/`transcripts` | disk | large (MAX_TRANSCRIPT 800, squad-manager.ts) |
| receipts (full) | disk `receipts/` | disk | already good on-disk primitive (receipts.ts) |
| digests | disk `digests/` | disk | cold-start blobs (digest.ts) |
| worktrees | disk (02) | disk | filesystem by nature |
| federation_peers | deferred (table exists) | — | federation is per-org/deferred (06) |

The schema already encodes this intent: `roster_index.data` holds full `PersistedAgent` JSON,
`usage.data` holds `RunReceipt` JSON, `audit` holds mutations (schema.ts:30-78). The tables exist
and are migrated (migrations.ts:27-94) but **nothing writes to them yet** — P2 wires them.

## The Store seam (`src/dal/store.ts`)

```ts
export interface Store {
  loadAgents(): Promise<PersistedAgent[]>;
  saveAgents(agents: PersistedAgent[]): Promise<void>;     // mirrors persistNow's batch write
  saveTranscripts?(t: Record<string, TranscriptEntry[]>): Promise<void>; // file store only; DB keeps on disk
  loadFeatures(): Promise<PersistedFeature[]>;
  saveFeatures(features: PersistedFeature[]): Promise<void>;
  appendAudit(entry: { actor: string; action: string; target?: string; detail?: unknown }): Promise<void>;
  appendUsage(receipt: RunReceipt): Promise<void>;
}
```

- **`FileStore(stateDir)`** — wraps today's behavior: `saveAgents`/`saveTranscripts` is exactly
  `persistNow()` (squad-manager.ts:1514-1525) writing `state.json` via temp+rename;
  `loadAgents` is `loadPersisted`/`reconnectLive`'s read of `state.json`; `appendUsage` is
  `appendReceipt(stateDir, …)` (already exists); `appendAudit` is a no-op or a local audit.log
  (file mode is single-tenant — audit optional). **Behavior-preserving.**
- **`DbStore(ctx: OrgContext, orgId)`** — every method runs through
  `withOrg(ctx, orgId, trx => …)` (dal/context.ts:26):
  - `saveAgents` → upsert one `roster_index` row per agent (`data` = full PersistedAgent JSON,
    plus the denormalized columns `id/name/repo/branch/worktree/model/kind/parent_id/issue/
    feature_id` per schema.ts:30-44) and delete rows for agents no longer present.
  - `loadAgents` → `select … from roster_index` (RLS + explicit `where org_id = orgId` — note
    `withOrg` sets the GUC; the query still carries the predicate per the DAL's defense-in-depth,
    dal/context.ts:11-13). Parse `data` back to PersistedAgent.
  - `appendAudit` → insert into `audit`.
  - `appendUsage` → insert/update `usage` (run_id PK per org).
  - features → `features` table likewise.
  - DB mode still writes transcripts/receipts/digests to the org's on-disk `stateDir` (02) — the
    DbStore does not move blobs.

## Threading into the manager

- `SquadManagerOptions` (squad-manager.ts:151) gains `store?: Store` (default
  `new FileStore(this.stateDir)` so file mode and existing tests are unchanged).
- Reroute the manager's persistence calls to `this.store`:
  - `persistNow()` (1514) → `this.store.saveAgents(agents)` (+ `saveTranscripts` for FileStore).
    Keep the `writeChain` serialization wrapper (1497-1511) — it's store-agnostic durability.
  - `loadPersisted()` (1529) / `reconnectLive()` (283) / `adoptOrphanedAgents()` (319) read via
    `this.store.loadAgents()` instead of `fs.readFile(this.stateFile)`. (These three currently
    each re-read `state.json`; consolidate to one `store.loadAgents()`.)
  - `finalizeRun()` (1208-1213): keep `appendReceipt(this.stateDir, …)` (full receipt on disk)
    **and** add `this.store.appendUsage(run.snapshot())` for the queryable ledger.
  - `featureStore` writes (`emitFeaturesChanged` → persist, 659-661; `createFeature` etc.)
    → `this.store.saveFeatures(...)`.
- **The DAL is constructed by the registry, not the manager.** The registry holds the single
  `OrgContext { db, type }` (from the daemon's `DbHandle`, index.ts:184) and builds
  `DbStore(ctx, orgId)` per manager. The manager imports only the `Store` interface — it never
  sees `Kysely`/`withOrg`. ponytail: one interface, two impls, no manager-wide DAL leakage.

## Audit at the chokepoint (new, security-relevant)

`applyCommand` (squad-manager.ts:943) is the single mutation chokepoint and is **already** where
RBAC is checked (943-951). Add an audit write there for every accepted mutation:
`await this.store.appendAudit({ actor: actor.id, action: cmd.type, target: cmd.id, detail: … })`
after the tier check passes and before/after the switch. Also audit auto-supervise answers
(`maybeAutoSupervise`, 1033-1049 — stamp `AUTO_ACTOR`) and lands (`land`/`landFeature`). This
populates the `audit` table P3 (06) and operators rely on. (File mode: FileStore.appendAudit may
be a no-op — single tenant, optional.)

## Why hybrid (not "everything in DB")

- Transcripts are large and append-heavy (per-entry rows would be the hot path); `state.json`
  temp+rename + the `writeChain` barrier (1497-1511) is already correct and battle-tested for the
  on-disk blobs that `stop()`/upgrade depend on.
- roster_index/features/usage/audit are small, must be queryable across the control plane (an
  admin listing orgs, a usage ledger, the audit trail), and are exactly what RLS protects. Making
  *them* authoritative in DB removes the dual-source-of-truth ambiguity for the roster while
  keeping blobs where blob primitives already work.

## Edge cases
- **Roster authority on reload (DB mode):** `roster_index` wins; disk holds only
  transcripts/receipts/digests keyed by agent id. `reconnectLive`/`adopt` reattach using the
  worktree path stored in the roster row's `data` (PersistedAgent.worktree). No state.json in DB
  mode.
- **SQLite self-host has no RLS:** isolation rests on `DbStore`'s explicit `where org_id = orgId`
  (the DAL's documented primary guard, dal/context.ts:11-13). Tests MUST assert this on SQLite.
- **Concurrent saveAgents** across the manager's own writeChain is serialized (1497); two
  different orgs use two DbStores/transactions — `withOrg` opens its own transaction each call.

## Verify
- `tests/dal-store.test.ts` (in-memory SQLite, reuse db/index.ts `openDatabase` + a seeded
  `organization` row per org): `DbStore(ctx,"A").saveAgents([a1])` then
  `DbStore(ctx,"B").loadAgents()` returns `[]` (cross-org read denied by the predicate);
  `DbStore(ctx,"A").loadAgents()` returns `[a1]` round-tripped through `data` JSON.
  `appendAudit`/`appendUsage` land under the right org and are invisible to the other.
- Manager-level: construct a manager with `FileStore` (default) → existing persistence tests
  still pass (behavior-preserving); construct with a fake `Store` → `create()` calls
  `saveAgents`, `applyCommand` mutation calls `appendAudit`.
