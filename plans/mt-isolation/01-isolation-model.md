# Isolation model — per-org SquadManager registry
STATUS: todo
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/manager-registry.ts, src/squad-manager.ts

## Decision

**Per-org `SquadManager` instances behind a lazy `ManagerRegistry`** — Option A. Reject
"one shared manager made org-aware on every call" — Option B.

## The two options

**Option A — registry of per-org managers.** A new `src/manager-registry.ts` holds
`Map<orgId, SquadManager>`. `registry.get(orgId)` returns the existing manager or lazily
constructs one with an org-scoped `stateDir`/worktree base/`Store` (see 02, 04), calls
`await manager.start()`, attaches a per-org event listener, and returns it. The existing
`SquadManager` (src/squad-manager.ts:172) runs **unchanged** — one fleet per org.

**Option B — one manager, org-aware per call.** Keep the single manager; tag every agent,
feature, transcript, event, timer-budget, and persisted record with `orgId`; filter every read
and scope every write by the caller's org.

## Why A (tradeoffs)

**Blast radius.** A registry contains failures to one tenant. The manager's failure modes are
fleet-global: a poisoned `state.json` (squad-manager.ts:1514 `persistNow`), a wedged
`writeChain` durability barrier (squad-manager.ts:1497), a runaway that hits
`hardAgentCeiling()` (squad-manager.ts:90), an exception in `poll()` (squad-manager.ts:1301), or
a single `EventEmitter` that throws in one listener — under Option B these hurt **every** org at
once. Under A they're confined to one org's manager; the others keep running.

**The single-fleet assumptions are pervasive — Option B has to rewrite ~40 methods and tax every
future one.** The manager assumes "one `agents` Map = one fleet" throughout:
`list()`/`projects()`, `poll()` (1301), `persist()/persistNow()` (1504/1514),
`loadPersisted()` (1529), `reapOrphans()` (1296), `reapDeadWorktrees()` (1365),
`sweepRegistries()` (1351), `featureStore` (179), `superviseBudget` (197), `closedIssues` (195),
`reattached` (199), the `EventEmitter` itself (every `emit("event", …)`), the `Dispatcher`
(236) and `Orchestrator` (250). Option B must add an `orgId` filter to each, and every *future*
method must remember to scope — a single missed `where org === actor.org` is a silent
cross-tenant leak. Option A makes isolation **structural**: manager A's Map cannot physically
contain org B's agents, so no per-call discipline is required and no future method can forget.

**Memory.** An idle manager is cheap — a few `Map`s and timers; the heavy cost is agent child
processes, which exist under either option. The real per-org cost is N×(poll 2.5s + dispatch 60s
+ presence + orchestrator) timers. Bounded by **idle eviction** (05): managers with no live
agents and no recent access are `stop()`ped (which detaches, doesn't kill) and dropped. A later
optimization can collapse the per-org `poll()` into one registry ticker iterating live managers,
but that is not required for v1 (ponytail: don't pre-build it).

**Persistence / federation / supervisor / lock already say "one manager = one fleet = one
stateDir."** Option A preserves that invariant *per org* (each manager gets its own
`stateDir = <root>/orgs/<orgId>`, see 02), so none of that internal logic changes. Option B
breaks all of it: the atomic temp+rename writer, the `bus.onRemoteCommand` → `applyCommand` path
(squad-manager.ts:224), and the per-agent `superviseBudget` would each need org partitioning.

**ponytail.** Option A is the lazy, smaller diff: a `Map` + `getOrCreate` + a per-org listener,
versus threading `orgId` through the entire manager surface. Less code, and the safer code.

## What the registry does NOT solve (handled elsewhere)

- **WS routing / event fan-out** is a server concern — the registry exposes per-manager event
  streams; the server buckets sockets by org and fans out (03).
- **Machine-global janitors** (host/socket reaping, the cross-org kill risk #1) are hoisted into
  the registry as a single union-based janitor (05) — flagged here because it is the one place
  Option A's per-manager logic is *unsafe* if left in the manager.

## ManagerRegistry contract (`src/manager-registry.ts`)

```ts
interface RegistryDeps {
  root: string;                 // OMP_SQUAD_STATE_DIR || ~/.omp/squad
  store: (orgId: string) => Store;   // DbStore(ctx, orgId) in DB mode (see 04)
  operator: Actor;
  bin?: string;
  // NO global bus in DB mode (see 06); pass NullFederationBus per manager.
}

class ManagerRegistry {
  get(orgId: string): Promise<SquadManager>;   // lazy create + start + attach listener; updates lastUsed
  peek(orgId: string): SquadManager | undefined;// no create (for "does this org have a live fleet?")
  onEvent(orgId: string, e: SquadEvent): void;  // server subscribes; drives per-org fan-out
  evictIdle(now: number): Promise<number>;      // 05
  stopAll(): Promise<void>;                      // 05 shutdown
}
```

The per-org manager is constructed:
`new SquadManager({ operator, bus: new NullFederationBus(), stateDir: path.join(root, "orgs", orgId), worktreeBase: path.join(root, "orgs", orgId, "worktrees"), store: store(orgId), bin })`.
The new `opts.worktreeBase` + `opts.store` come from 02 and 04.

**Event wiring:** for each created manager, `manager.on("event", e => this.onEvent(orgId, e))`.
The server registers an `onEvent` callback on the registry; the closure carries `orgId`, so the
server always knows which org an event belongs to without tagging the event payload. On evict,
remove the listener.

## File mode

The registry is **not used** in file mode (no `DATABASE_URL`). `index.ts` keeps constructing the
single `SquadManager` at the root (today's path) and the `SquadServer` keeps a single-manager
fast path. The registry exists only when `auth`/`db` are present. (See 03 for how the server
chooses single-manager vs registry.)

## Verify
- `tests/manager-registry.test.ts`: `get("A")` twice returns the same instance; `get("A")` vs
  `get("B")` are distinct; each manager's `stateDir`/`worktreeBase` carries its org segment;
  `peek` on an unseen org returns `undefined` without creating.
- Assert a manager for org A and one for org B have disjoint `agents` Maps after `create()` on
  each (structural isolation).
