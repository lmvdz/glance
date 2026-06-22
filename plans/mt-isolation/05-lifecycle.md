# Lifecycle — lazy create/evict, locks, janitors, autonomy loops
STATUS: todo
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/manager-registry.ts, src/squad-manager.ts, src/index.ts

## Decision

One daemon process owns all orgs under one root lock. Per-org managers are created lazily and
evicted when idle. The **machine-global janitors** that today live inside the manager are hoisted
to the registry so per-org managers cannot reap each other's hosts. Autonomy loops are per-org
for free (they live in `manager.start()`), with two carve-outs: the external WS supervisor runs
in file mode only, and Plane auto-dispatch config stays daemon-global (single-org-meaningful).

## Lazy create / evict

- **Create:** `registry.get(orgId)` (01) — return existing or construct + `await
  manager.start()` + attach the per-org event listener. Must be **idempotent under concurrency**:
  hold an in-flight `Promise<SquadManager>` per org in the map so two simultaneous first requests
  share one create (store the promise, not just the resolved manager).
- **Evict:** a registry timer (e.g. every 60s) calls `evictIdle(now)`: for each manager with
  **no live agents** (`manager.list()` all `stopped`/empty) **and** `now - lastUsed > TTL`
  (default ~10 min, `OMP_SQUAD_ORG_IDLE_MS`), call `manager.stop()` and drop it (remove listener,
  delete from map). `manager.stop()` already **detaches** (does not kill) agents and persists
  (squad-manager.ts:271-278), so eviction is safe: a later `get(orgId)` re-creates the manager
  and `reconnectLive()`/`adoptOrphanedAgents()` (start(), 217-220) reattach to surviving hosts /
  resume worktree context. **Never evict a manager with a `working`/`starting`/`input` agent.**
  This reuses the existing restart-recovery path — eviction is just "restart later, on demand."

## Single-daemon lock (unchanged)

Keep exactly one `acquireStateLock(root)` at the **root** stateDir (index.ts:197;
state-lock.ts). One daemon process owns the whole `<root>` (including all `orgs/<id>/`), so per-
org managers do **not** take their own locks — they share the process. The lock's pid/host/
signal-0 semantics and the upgrade-handoff window are untouched. (A per-org lock would be wrong:
it's the *process* that must be single-writer over the shared sockets dir, not each fleet.)

## Machine-global janitors — the hoist (risk #1 fix)

These operate on **machine-wide** resources and MUST NOT run per-manager-with-only-its-own-agents:

1. **`reapOrphanHosts(ids)`** — kills any agent host whose id ∉ `ids`. Today
   `reapOrphans()` passes `new Set(this.agents.keys())` (squad-manager.ts:1296-1297). With N
   managers, manager A would pass only org A's ids and **kill org B's live hosts**. Agent-host
   sockets live in a shared machine-wide dir (agent-host.ts `socketPathFor`), and ids are
   globally unique (`newAgentId`, squad-manager.ts:110), so the *paths* don't collide — but the
   reap set does. **Fix:** the registry runs `reapOrphanHosts(union)` once, where `union` =
   `⋃ manager.list().map(a=>a.id)` across all live managers. Remove the `reapOrphans()` call from
   `manager.start()` (218) and `poll()`'s periodic reap (the `reapTicks` throttle, 186/1296);
   move both to a registry janitor timer.
2. **`pruneStaleSockets()`** — machine-wide socket dir cleanup (squad-manager.ts:222). Run once
   at registry boot, not per manager.
3. **`sweepRegistries()`** (`sweepLeases/sweepPresence/sweepProofs`, squad-manager.ts:1351-1353)
   — global `~/.omp/squad/{leases,presence,proofs}` dirs (presence.ts:11, leases.ts:9). Hoist to
   the registry (run once); they prune by TTL so a union isn't needed, but running them N× is
   wasteful and racy.
4. **`reapDeadWorktrees()`** (squad-manager.ts:1365) — **stays per-manager**: once worktree bases
   are org-scoped (02), each manager's worktree scan only sees its own org's worktrees
   (`this.agents` + `planeRepos()`), so there is no cross-org collision. Confirm the `owned` set
   (1368) and repo set (1369) are derived from `this.agents` only — they are.

**Mechanism:** give the manager a constructor hook
`opts.ownedHostIds?: () => Set<string>` it consults instead of `this.agents.keys()` for reaping —
the registry passes a closure returning the union; or, cleaner, **remove host/socket reaping from
the manager entirely** and own it in the registry. Recommend the latter (single responsibility):
the registry's janitor timer calls `reapOrphanHosts(union)`, `pruneStaleSockets()`,
`sweepRegistries()`. The manager keeps only `poll()` (per-agent health/land) and
`reapDeadWorktrees()` (org-scoped). File mode: index.ts (no registry) keeps the manager's
existing reaping path — so add the hoist **only on the DB-mode registry path**, leaving the
single-manager file path with today's in-manager reaping (smallest diff, no file-mode regression).

## Autonomy loops

- **In-process `maybeAutoSupervise`** (deterministic risk-gated answerer, squad-manager.ts:1033)
  — lives inside each manager → **per-org for free**. The per-agent `superviseBudget` (197) is
  naturally org-partitioned. No change.
- **`Dispatcher`** (Plane auto-dispatch, squad-manager.ts:236-247) + **`Orchestrator`** (auto-
  land, 250-262) — created in `manager.start()` → per-org for free. **But** they read
  **daemon-global** Plane config (`planeRepos()`, 233/237). In true multi-tenant SaaS every org
  would dispatch the same repos — wrong. **Decision for P2:** keep the loops per-org (free), but
  Plane repo config remains daemon-global, which is only meaningful for single-org self-host.
  Per-org Plane configuration is a **deferred follow-up** (out of P2 scope) — mark with a
  `ponytail:` comment. Optionally gate auto-dispatch off by default in DB mode until per-org
  Plane config exists (`OMP_SQUAD_AUTODISPATCH` already gates it, 233).
- **External `startSupervisor`** (index.ts:221-222; supervisor.ts:245) — a single global WS
  client authenticating with the **file-mode bearer token** (supervisor.ts:248 `readToken`, 311
  `new WebSocket(wsUrl, ["ompsq-token", token])`). DB mode has no bearer token and the WS now
  requires a session + org. **Decision:** start the external supervisor in **file mode only**
  (index.ts: gate `startSupervisor` on `!dbHandle`). DB-mode auto-supervision is the per-org
  in-process `maybeAutoSupervise` (above). Model-backed per-org supervision, if wanted later, runs
  as an in-process per-manager hook, not an external WS client. Document in supervisor.ts header.

## Shutdown

`index.ts` `shutdown()` (229-231): DB mode → `await registry.stopAll()` (each `manager.stop()`
detaches + persists) → `await dbHandle.close()` → `lock.release()`. File mode → today's single
`manager.stop()`. The registry's `stopAll` also clears its janitor + evict timers.

## Edge cases
- **Evict races a new command:** `get` updates `lastUsed`; `evictIdle` re-checks live-agent count
  and `lastUsed` under the same tick — if a command arrived, skip eviction. Acceptable to
  occasionally re-create immediately after evicting.
- **Restart with many orgs:** the daemon does NOT eagerly start all orgs' managers on boot —
  managers are created lazily on first request. Surviving detached hosts from any org are
  reattached when that org's manager is first `get()`-ed. (The registry's boot-time
  `reapOrphanHosts(union)` must therefore tolerate an empty union initially — it would otherwise
  kill *all* surviving hosts. **Fix:** at boot, before reaping, enumerate persisted agents across
  all `orgs/<id>/` roster sources to seed the protected-id union, OR defer the first global reap
  until each org's manager has been lazily started. Recommend: seed the union from
  `DbStore.loadAgents()` across orgs — a cheap roster_index scan — so boot reaping never kills a
  to-be-adopted host.) **This is a correctness trap; call it out in implementation.**
- **Timer count under many orgs:** acceptable for the expected tenant count; eviction bounds it.
  Note the shared-ticker optimization as future work.

## Verify
- `tests/manager-registry.test.ts`: `evictIdle` evicts an idle, agent-less manager (asserts
  `stop()` called, map entry gone) and **skips** one with a live agent; a `get` after evict
  returns a fresh instance.
- Janitor union: a fake registry with two managers (org A id-set {a1}, org B {b1}); assert the
  registry computes the reap-protected union {a1,b1} (so a single-org reap can't target the
  other). Boot-seed: union seeded from `loadAgents()` is non-empty before any manager starts.
