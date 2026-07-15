# Research brief: From fork() to Fleet — Designing an Agent Sandbox Cloud

## Provenance

- **Date researched**: 2026-07-15
- **Source**: Talk — "From fork() to Fleet: Designing an Agent Sandbox Cloud", Abhishek Bhardwaj (OpenAI, RL & Agent Infrastructure). Video: https://www.youtube.com/watch?v=OqM67QG_Ikk
- **Input form**: user-supplied talk summary (pre-extracted artifact), verified against the published talk listing. The summary was NOT re-derived from the video itself — claims about implementation specifics (FIEMAP/XFS, NBD tiered cache) are taken from the summary and marked as such. Confidence on the talk's *content* is therefore medium; confidence on the codebase mapping below is high (grounded in a source-level sweep of omp-squad on branch `voice-live3`, post-#189, 2026-07-15).
- **Target project**: omp-squad ("glance") — single-node fleet-orchestration daemon that dispatches AI coding-agent units into isolated git worktrees, runs Docker-sandboxed verification gates, and lands PRs; file-mode (local `state.json`) and DB-mode (hosted multi-tenant, per-org BYO keys) personalities.

## Scout brief (the talk, distilled)

**Problem**: models are trained to emit code-execution tool calls; that code is untrusted (malicious or over-zealous). Every execution must run somewhere that can't hurt the host or other tenants.

**Three pillars**:

1. **Runtime** — the isolation spectrum: raw fork/exec (none) → containers (shared kernel, seccomp is brittle) → gVisor (user-space kernel, still a two-step chain to the host) → **microVMs** (KVM + Rust VMMs: Firecracker/Cloud Hypervisor; virtio; device jailing). Verdict: start at microVMs for high-value/untrusted work; "skip the seven stages of sandbox grief" — you can fix performance with systems work, you can't fix a trust breach.
2. **Persistence** — a sandbox without a durable disk is a laptop that wipes on lid-close. Long-horizon agents need incremental (changed-blocks-only), very cheap snapshot/restore, offered both always-on and as an explicit-save API. Implementation patterns cited: CoW + FIEMAP on XFS (zero-copy base + writable overlay); always-on NBD block device over a tiered cache (node → cluster → object storage) so the guest sees plain POSIX. Persistence doubles as reliability: restore the exact sandbox elsewhere after node failure or during upgrades.
3. **Orchestration** — hierarchical control plane (region → cluster → node scheduler with load/affinity/failure awareness); low-latency creation via pre-warm pools and memory snapshots of running microVMs (ms starts); snapshot-aware placement (prefer the node already holding most snapshot layers).

**Core intuition**: security is a foundation, not a feature; once the boundary is solid, the product leverage is fast incremental persistence — ephemeral executors become durable, checkpointable, explorable agent environments.

## Target-project ground truth (source-verified 2026-07-15)

What glance actually has today on the same three pillars:

**Runtime/isolation**
- Unit isolation is *workspace* isolation, not *execution* isolation: every unit gets its own git worktree (`src/worktree.ts:136` `addWorktree`, base `<stateDir>/worktrees/`), but the agent itself runs as a plain host subprocess — detached agent-host (`src/rpc-agent.ts:225-258` `spawnHost`) which `Bun.spawn`s the harness CLI (`src/agent-host.ts:150-176`). Same uid as the daemon, full network, **no cgroup/ulimit/seccomp/namespace of any kind** on the agent lane.
- Dep provisioning runs `bun install` **on the host** with a 120s timeout and scrubbed env (`src/worktree.ts:83-130`) — untrusted repos' postinstall scripts execute outside any sandbox.
- The **verification gate** is the one sandboxed-by-default lane: `docker run --rm --init --network none --user <uid:gid> …` (`src/gate-runner.ts:228-257` `sandboxPlan`, image `glance-gate:bun1-v2`), with a legible degradation ladder (`src/gate-env.ts`: auto → host fallback stamped `sandboxed:false`; `OMP_SQUAD_GATE_SANDBOX_STRICT=1` fails closed; `gateRunUnrunnable`/`greenGateUnproven` fail closed at `src/gate-runner.ts:359-390`).
- An agent-execution sandbox EXISTS but is opt-in, omp-RPC-only, and default-less: `SandboxAgentDriver` (`src/sandbox-agent-driver.ts:86-103`, `docker run -d … sleep infinity` + `docker exec`), selected only when `CreateAgentOptions.sandbox` is supplied (`src/squad-manager.ts:4994-4998`; non-omp harness × sandbox rejected at `:4622`). It sets **no default** `--network`/`--user` flags — the caller must pass them via `runArgs`.
- Env-side least privilege is already strong: deny-by-shape scrub + keep-list + per-spawn provider credential injection (`src/spawn-env.ts`, `harnessAuthEnv` `:185-196`); hardened git everywhere (`src/git-harden.ts`).

**Persistence**
- File mode: one `state.json`, **full-replace on every save** (O(roster) rewrite, `src/dal/store.ts:115-132`) through a pluggable `StorageBackend` (`src/dal/storage.ts:61-90` local fsync+rename; `ArchilStorageBackend` stub fails loud at `:183-220`). DB mode: kysely/Postgres tables; transcripts stay on org disk either way (`store.ts:184`).
- Restart recovery (`src/squad-manager.ts:1003-1013`): re-attach to still-running detached hosts (`reconnectLive` `:1498` — in-flight work survives daemon restart *if the host survived*), then `adoptOrphanedAgents` (`:1554`) for dead-host units with unlanded work — capped (`selectAdoptable`, `src/spawn-identity.ts:41`), and a re-adopt spawns a **fresh harness session: the in-harness conversation is lost**; only git bytes in the worktree carry over.
- Real checkpoint/resume exists **only for workflow units**: append-only checkpoint log (`src/workflow/checkpoint-log.ts`), resumed on adoption (`squad-manager.ts:1563,1622-1623`), over-ceiling checkpoints deferred not dropped (`spawn-identity.ts:53`). Shipped by the closed `plans/never-lose-work` plan (incl. fork-from-step-N).
- Worktree reaping is conservative and correct (`src/worktree-reaper.ts:87` `selectReapable`: dirty ⇒ never reaped; branch delete only when provably merged). No content-addressed/incremental/CoW storage anywhere; no process/memory checkpointing.

**Orchestration**
- Single-node, single-daemon by construction (`src/state-lock.ts` single writer). Dispatcher polls Plane, priority-orders, spawns (`src/dispatch.ts:187` `tick`), gated by dispatch cap (default 3, `:183`), global WIP cap (`src/scheduler.ts:37-74`, default ~half CPUs), hard agent ceiling (`src/spawn-identity.ts:18`), per-provider rate-limit pause, dependency defer, restart-safe dispatch ledger. Gate runs serialized (`src/gate-semaphore.ts`, default 1).
- Scheduler has a FIFO queue that **nothing parks on** — over-cap issues just wait for the next tick (`scheduler.ts:6-9` header admits backpressure loop #13 unlanded).
- **No pre-warming or pooling of anything**; every unit cold-starts: `git worktree add` → symlink or cold `bun install` (≤120s) → detached host spawn → harness boot → unix-socket `waitReady` (≤60s, `src/rpc-agent.ts:200-223`).
- Federation (`src/federation-sync.ts`) shares presence + file leases only — no placement, no cross-node scheduling.

## Concept extraction (comparator table)

| Concept | How the talk's world implements it | Transferable to glance? | Why / why not |
|---|---|---|---|
| Isolation floor chosen deliberately per trust class | microVM default (Firecracker/Cloud Hypervisor), containers only for low-value work | YES — as container-by-default agent execution | glance's trust classes already exist implicitly (own repo vs foreign repo vs hosted tenant); the execution tier doesn't vary with them |
| "Skip the sandbox grief stages" (don't climb the ladder breach-by-breach) | Start at the strong boundary; buy performance back later | YES | glance is at rung 0 (host exec) for agents while DB-mode hosting is actively being built — exactly the founder mistake the talk warns about |
| Device jailing / least-privilege decomposition | Compromised virtio block device can't touch the net device | PARTIAL | glance's env-scrub + per-spawn credential injection IS this pattern for secrets; the process/filesystem/network legs are missing |
| Durable disk as the agent-productivity unlock | CoW + FIEMAP incremental snapshots; NBD tiered cache | YES, translated | glance's "disk" = worktree (git is already CAS/incremental) + **harness session** (not persisted at all for plain units) — the session is the missing overlay |
| Always-on + explicit-save persistence APIs | Continuous block snapshots + save API | YES | always-on = auto-WIP checkpoint commits + session-handle records; explicit = the existing workflow checkpoint/fork machinery, extended to plain units |
| Persistence as reliability (restore elsewhere on node death) | Failed node ⇒ restore exact sandbox on another node | YES, single-node analog | dead *host process* ⇒ resume the same conversation, not just the same bytes; also the argument for finishing the `StorageBackend` seam in hosted mode |
| Pre-warm pools / memory snapshots for ms creation | Warm microVM pools; snapshot a booted VM | YES, translated | pre-provisioned worktree pool + (optionally) pre-booted idle harness hosts; glance's cold path is minutes, interactive flows (promote/adopt/voice) feel it |
| Snapshot-aware placement | Prefer node already holding snapshot layers | YES, translated | single-node analog: prefer *retargeting* an existing clean reapable worktree (warm node_modules, warm checkout) over remove+add |
| Hierarchical control plane at fleet scale | Region → cluster → node schedulers | NO (not yet) | glance is deliberately single-node; federation is presence-only. Record as non-adoption; the seam to revisit is federation + StorageBackend |
| gVisor as a middle tier | User-space kernel | NO | the talk's own verdict (chainable) + an extra runtime dependency glance doesn't need; Docker→microVM is the right two-tier ladder |

## Ranked transferable concepts (strategist)

### 1. Container-by-default agent execution, on a legible isolation ladder

**Pattern**: pick the execution-isolation tier per trust class of the workload — deliberately, once — instead of climbing the ladder one breach at a time. Every tier degradation must be legible and fail-closed-able.
**Mechanism**: default agent execution into a container (workspace bind-mounted, `--network` and `--user` set by the *driver*, not the caller); host execution becomes the explicit opt-out; a strict mode refuses to run untrusted classes unsandboxed. MicroVM (Firecracker/Cloud Hypervisor) is a *third tier* to buy later, not build now.
**Value for glance**: today an agent unit — including on foreign repos, including `bun install` postinstall scripts — executes on the operator's host with full network and the daemon's uid. DB-mode hosting (per-org BYO keys, draft PR #172 lineage) makes glance multi-tenant, and host-subprocess agents are then a cross-tenant boundary hole, not a hygiene issue. The talk's one non-negotiable ("security breaches destroy trust; performance you can buy back") lands squarely here.
**Where it applies**: promote `src/sandbox-agent-driver.ts` from opt-in curiosity to default lane — give it default `--network`/`--user`/mount flags mirroring `sandboxPlan` (`src/gate-runner.ts:228-257`); lift the omp-only restriction (`src/squad-manager.ts:4622`) via the same exec-in-container shape for other ACP harnesses; move `provisionWorktreeDeps`' `bun install` (`src/worktree.ts:83-130`) inside the container; reuse the gate's mode ladder + strict-mode semantics from `src/gate-env.ts` (auto → legible host fallback → `STRICT` fail-closed).
**Build vs Buy**: borrow the pattern; keep Docker as the container tier (already a hard gate dependency, image-build machinery exists at `gate-runner.ts:182`). Explicitly do NOT adopt gVisor. Note for the hosted future: WSL2 exposes nested KVM, so a Firecracker tier is not environmentally blocked — but it's a buy-when-hosting decision, not now.

### 2. Resumable units: persist the session, not just the bytes

**Pattern**: an agent's durable state is workspace + conversation. Snapshot both, incrementally, always-on — so any dead unit can be restored *mid-thought* rather than restarted from its artifacts.
**Mechanism**: (a) record each unit's harness session handle (claude-code `--resume <session-id>`, omp RPC session, codex thread) in the roster row at spawn; (b) on adoption of a dead-host unit, resume that session instead of minting a fresh one, falling back to fresh only when the harness can't resume; (c) always-on WIP checkpointing — periodic auto-commit of dirty worktree state to a `wip/` ref so uncommitted work survives even worktree loss. Git is already the content-addressed incremental snapshot store; the session handle is the missing overlay.
**Value for glance**: `adoptOrphanedAgents` currently discards the entire in-harness conversation — hours of context — and re-derives it from git bytes. That is precisely the "laptop that wipes on lid-close" failure the talk names as the productivity ceiling. This also strengthens reconnect-after-crash beyond the lucky case where the detached host survived.
**Where it applies**: `PersistedAgent` (`src/dal/store.ts:44-46`) + roster schema gain a session-handle field; `adoptOrphanedAgents`/`selectAdoptable` (`src/squad-manager.ts:1554`, `src/spawn-identity.ts:41`) try resume-first; extends the closed `plans/never-lose-work` machinery (checkpoint log, fork-from-step) from workflow units to plain units — a follow-on plan, not a rewrite.
**Build vs Buy**: build; it's glue over capabilities the harnesses already ship.

### 3. Warm-start pool + retarget-instead-of-reap

**Pattern**: pre-pay creation cost in the background so unit creation is assignment, not construction; when restoring/creating, prefer substrate that already holds most of what you need.
**Mechanism**: keep N pre-provisioned worktrees per registered repo (worktree added at origin/main, deps provisioned) — dispatch claims one and retargets the branch (`git checkout -B` in an existing worktree is near-free) instead of `worktree add` + install; the reaper feeds the pool (clean reapable worktrees get recycled, not removed). Optionally, a pre-booted idle harness host per profile for the interactive lanes.
**Value for glance**: the cold path is worktree add + up-to-120s `bun install` + host spawn + up-to-60s ready handshake. Batch dispatch tolerates that; the interactive surfaces glance is building — promote-console-chat (#184), adopt (#187), voice-initiated units — do not. This is the talk's pre-warm-pool + snapshot-aware-placement pair collapsed to one node.
**Where it applies**: `src/worktree.ts` (`addWorktree`/`resolveWorktree`), `src/worktree-reaper.ts:87` (`selectReapable` gains a recycle path), `src/dispatch.ts` claim path, `src/rpc-agent.ts` for optional host pre-boot.
**Build vs Buy**: build; small and local.

### 4. Isolation legibility: stamp every unit with its execution tier

**Pattern**: the isolation tier a workload actually ran under is a first-class, immutable, rendered fact — never inferable-only, never silently degraded.
**Mechanism**: roster rows and receipts carry `execTier: host | container | microvm` + why (config, docker-missing fallback, strict-refused); UI renders it beside trust/validator state; land/verify receipts include it so a green gate on a host-fallback run is visibly weaker.
**Value for glance**: glance already learned this lesson twice — gate runs stamp `sandboxed:false` on fallback, and PR #67 exists because validator veto was rendered nowhere. Extending the honesty tier to *agent execution* is cheap now and makes concept 1's ladder auditable instead of aspirational.
**Where it applies**: `PersistedAgent`/roster schema (`src/dal/store.ts`, `src/db/schema.ts`), receipts, webapp roster/TaskDetail surfaces.
**Build vs Buy**: build; it's a field + rendering.

### 5. Incremental state persistence (retire the O(roster) full rewrite)

**Pattern**: persistence cost scales with the delta, not the corpus.
**Mechanism**: append-only journal of roster mutations with periodic compaction into the snapshot (the workflow checkpoint log at `src/workflow/checkpoint-log.ts` is already this shape); or lean on DB mode where rows are already incremental.
**Value for glance**: file mode rewrites the full `state.json` on every save (`src/dal/store.ts:13,115-132`). Fine at today's roster; a known cliff as fleets and transcript metadata grow, and the same journal becomes the sync unit if the `StorageBackend` seam (`src/dal/storage.ts:183-220` Archil stub, `plans/storage-provider-seam`) ever ships tiered/remote storage — the talk's node→cluster→object-store cache, one node's worth.
**Build vs Buy**: build (or "adopt DB mode" for anyone who feels the cliff). Rank low: real but not currently binding.

### Deliberate non-adoptions

- **MicroVM runtime now** — wrong tier for a single-operator WSL2 daemon whose agents are semi-trusted collaborators; revisit at hosted multi-tenant GA (and note WSL2 nested KVM makes it feasible even for dev).
- **Hierarchical multi-node control plane** — glance is single-node by design (`src/state-lock.ts`); federation is presence-only. The pattern's single-node residue (snapshot-aware placement → warm-worktree preference) is captured in concept 3.
- **gVisor** — dominated on both sides of its own tradeoff, per the talk and per glance's needs.

## Suggested next step

Concepts 1+4 are one coherent `/plan` (isolation ladder + legibility — they ship together or the ladder is unauditable); concept 2 is a natural `plans/never-lose-work` follow-on; concept 3 stands alone as a latency plan. 5 is a note for the storage-seam re-land.
