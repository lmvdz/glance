# Design: durable, process-independent workflow resume

> Source: `/research https://github.com/mastra-ai/mastra` → concept #1 (process-independent durable
> execution). mastra persists a full workflow snapshot to storage and resumes from `runId` with no live
> process. omp-squad already has the checkpoint primitive; this plan closes the gap between "checkpoint
> exists" and "a crashed run actually resumes, exactly once, without losing or duplicating work."
>
> Hardened by an adversarial design pass (2× opus red team). Their findings are folded in below; several
> reshaped the design (two-phase checkpoint, preserve-on-disk, drop the resumeMode enum, drop C03).

## Problem

omp-squad persists an `EngineCheckpoint` at each workflow node boundary (`src/workflow/engine.ts:79`) and
stores it as `AgentDTO.workflowState` on every boundary (`src/squad-manager.ts:1461-1463`, fire-and-forget
`void this.persist()`). Yet graph runs survive a daemon restart only along a narrow path, with two verified
defects.

**D1 — lost / *erased* resume.** `adoptOrphanedAgents` (`squad-manager.ts:474-511`) chooses what to resume
with `persistedHasWork` (worktree dirty or commits ahead — `515-522`), **not** the checkpoint. A workflow
that crashed at an early not-yet-committed stage (plan/research, or just past a human gate), or whose work
already landed but has remaining post-land stages, is dropped by `selectAdoptable`
(`142-145` = `eligible.filter(hasWork).slice(0,cap)`). Worse, the dropped record is **permanently erased**,
not deferred: `persistNow` serializes only the live roster (`squad-manager.ts:1960`) and `store.save` is a
full-snapshot replace in both FileStore and DbStore (`src/dal/store.ts:118-124,179-200`), so the first
`create()` in the adopt loop (`create()` calls `persist()`, `1103`), or the next poll/stop flush, overwrites
`state.json` / the `roster_index` rows without the dropped agent. The in-code safety net — "a still-open
issue re-dispatches gradually under the WIP cap" (`478-479`) — is sound for plain agents (the Plane issue is
the durable source of truth) but **unsound for workflows**: the checkpoint is the only copy of the run.

**D2 — unsound cold resume.** When the inner `omp` thread is dead, adoption re-creates the agent and
`WorkflowDriver.start` resumes via `execRun(goal, resumeState)` → `engine.run(goal,{resume})`. The in-flight
`currentNode` re-enters via `executor.resumeAgent` (`engine.ts:191`), which acquires a **fresh** inner thread,
sees `isStreaming:false` (`executor.ts:149-150`), returns `{succeeded,""}` and **advances past the node** —
skipping its work. And `primed=true` (seeded from `initialRollup`, `executor.ts:78-80`) means every
subsequent agent node never sends the goal to the fresh thread. `persistedHasWork` masks this today (it only
resumes when committed work already exists); fixing D1 *widens* exposure to D2, so the two are coupled.

## Approach

Two ordered concerns. The linchpin is a **two-phase checkpoint** that makes "completed" unambiguous on
disk, collapsing the re-run ambiguity to exactly the one genuinely in-flight node — which then re-runs
soundly under a bounded attempt cap.

**C01 — sound cold resume (executor-local) + two-phase checkpoint.** Lands first; it must exist before C02
widens the set of runs that cold-resume.
- *Two-phase checkpoint* (`engine.ts`): keep the existing entry checkpoint (preserves the warm reattach
  property), and **add** a second checkpoint after `execute()` completes with `currentNode` advanced to
  `next`. A finished node has already advanced on disk → it is never re-run on cold restart. The only
  re-runnable node is one that crashed between its own entry and exit checkpoints = genuinely in-flight.
- *Cold vs warm is a free boolean*, not a computed mode: `reconnectLive` resumes only when the inner host
  **survived** ⇒ warm; `adoptOrphanedAgents` runs only when the host is **gone** and the inner `-wf` is
  re-created fresh ⇒ cold. Thread one `cold` flag from the adopt path into the executor.
- *Cold resume of the in-flight node*: when `cold`, the in-flight node re-runs via `runAgent` with
  `primed=false` (re-sends the goal to the fresh thread) instead of `resumeAgent`. Warm stays
  reattach-without-re-prompt, unchanged.
- *Poison cap*: persist `resumeAttempts` in the checkpoint; increment on each cold resume of the same
  `currentNode`; after N (3) escalate-to-human instead of re-running. This is the only thing that bounds a
  run that crashes the daemon before reaching idle (the engine visit-cap does **not** — the resumed node is
  not re-counted, `engine.ts:63-64`).
- *Feed-forward survival*: persist the pending post-gate fold (`gateJustPassed` / resolved `decoratePrompt`
  text) in the checkpoint so a cold restart on the node right after a human gate still injects the reviewer
  comments instead of running blind.

**C02 — checkpoint-authoritative, loss-free adoption.** BLOCKED_BY C01.
- *Eligibility*: a `workflow` agent carrying `workflowState` is resumable — OR it into the `hasWork`
  predicate `adoptOrphanedAgents` feeds `selectAdoptable`.
- *Preserve, don't erase* (the real D1 fix): un-adopted eligible checkpointed records are kept and written
  back through `persistNow` (a `deferred` set deduped by id), so a later routine restart re-attempts them.
  This removes silent permanent loss **without touching the OOM ceiling**.
- *Never direct-land a workflow*: `adopted: p.kind !== 'workflow'` (`squad-manager.ts:506`). A resuming
  workflow lands only via its own `workflow_done → autoLandOnSuccess` (`1534-1538`); `adopted:true` would
  let the orchestrator merge an unverified partial worktree (`orchestrator.ts:196-204`).
- *Don't independently land fan-out branches*: exclude `parentId` children from independent adoption
  (`!p.parentId` in `agentsToAdopt`, `128-134`). A branch belongs to its parent run, not landable alone.
- *Don't re-adopt halted runs*: skip branches the existing restart-safe ledger marks halted
  (`openOrchestratorState(stateDir).isHalted(branch)`), reusing the ledger the orchestrator already keeps.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Disambiguate completed vs in-flight | **Add** an exit checkpoint (two-phase); keep entry | Move checkpoint to exit only | Pure-exit breaks the warm "reattach to an in-flight turn without re-prompting" property (`workflow-resume.test.ts:112`). Add, don't replace — the draft's rejection was a false dichotomy (RTC-F3). |
| Cold/warm signal | A `cold: boolean` sourced for free (reconnect=warm, adopt=cold), executor-local | `resumeMode: 'reattach'\|'restart'` enum across 5 files + `types.ts` | It encodes one bit the adopt-vs-reconnect path already determines; enum is over-built (RTS-F3). Fix lands in ~3 files. |
| In-flight node on cold resume | Re-run via `runAgent` + re-prime, bounded by `resumeAttempts` | Skip (current D2); escalate-always | Skipping silently drops work; escalate-always defeats autonomy. Re-run is the only sound default; the attempt cap + idempotency requirement bound the one unavoidable duplicate-side-effect case. |
| D1 fix shape | Preserve un-adopted checkpoints on disk | Prioritize checkpointed workflows ahead of plain agents under the ceiling | Prioritization is a probability tweak that does nothing at `cap<=0` and the record is erased regardless (RTS-F1). Preserve-on-disk fixes loss outright and leaves the OOM guard intact. |
| `adopted` flag for workflows | Never (`p.kind !== 'workflow'`) | Gate on `workflowState\|\|persistedHasWork` | The weaker gate still mis-lands a dirty no-checkpoint workflow; workflows already auto-land via `workflow_done` so `adopted:true` is both redundant and dangerous (RTC-F5, supersedes RTS-F2). |
| C03 (no-checkpoint → restart-from-start) | Dropped | Standalone concern | The "live host + no checkpoint" window is a sub-ms async-flush race salvaging ≈ node 1; current warn+abandon is fine (RTS-F4). Falls out for free as the cold path with `currentNode=wf.start` if ever wanted. |
| Poison-loop bound | Persisted `resumeAttempts` in checkpoint **and** skip `isHalted` in adopt | New ledger | No new ledger — reuse the existing orchestrator-state/land-ledger for the idle-failed case; the counter only covers the crash-before-idle case the ledger can't see (reconciles RTC-F4 + RTS-F5). |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Genuinely in-flight node re-runs on cold resume → duplicates non-worktree side effects (re-file Plane issue, re-push) | known ceiling | Two-phase checkpoint shrinks this to one node crashed mid-turn; `resumeAttempts` cap stops a loop; `.fabro` nodes documented as continuation-safe / HEAD-keyed. `ponytail:` upgrade path = per-node idempotency key. |
| Interrupted fan-out re-runs **all** branches (branches are not individually checkpointed) | known ceiling | `!parentId` exclusion prevents orphaned branches landing independently; re-run is bounded by fan-out being opt-in + N×-cost-capped. `ponytail:` upgrade = per-branch checkpointing. |
| Socketless-but-alive inner `omp` reads as dead → cold spawn starts a 2nd `omp` in the same worktree (RTC-F8) | significant | Pre-existing; cheap guard = refuse/await a cold spawn when a git index `.lock` exists in the worktree. Robust pid reaping is out of scope (no pid bookkeeping today). |
| Half-dead inner (socket answers but wedged) → warm reattach stalls to the 10-min turn timeout (RTC-F9) | minor | Add a short `getState()` deadline in `resumeAgent`; fall through to cold. Deferred — acceptable. |
| Resumed node double-counts in the progress rollup (RTC-F10) | cosmetic | Dedupe the resumed node's stage-start when seeding `initialRollup`. Folded into C01 cheaply. |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| RTC-F1 cold re-run repeats external side effects | critical | Two-phase checkpoint (C01) makes it the *only-in-flight* node, not every node; bounded by `resumeAttempts` + documented node idempotency. |
| RTC-F2 fan-out double-run + double-land | critical | `!parentId` adoption exclusion (C02) kills double-land; re-run-all-branches accepted as a documented ceiling. |
| RTC-F3 entry-only checkpoint ambiguous | critical | Two-phase checkpoint added (C01). |
| RTC-F4 visit cap doesn't bound cold loop | significant | Persisted `resumeAttempts` cap (C01). |
| RTC-F5 / RTS-F2 `adopted:true` mis-lands | significant | `adopted: p.kind !== 'workflow'` (C02). |
| RTC-F6 command nodes always re-run | significant | Two-phase checkpoint (finished command not re-run); document command scripts must be idempotent/HEAD-keyed. |
| RTC-F7 post-gate feed-forward lost | significant | Persist pending fold in checkpoint (C01). |
| RTS-F1 dropped checkpoint permanently erased | critical | Preserve-on-disk via `persistNow` deferred set (C02) — the real D1 fix. |
| RTS-F3 resumeMode enum over-built | significant | Replaced with a `cold` boolean, executor-local (C01). |
| RTS-F4 C03 YAGNI | significant | Dropped. |
| RTS-F5 reuse existing halt ledger | minor | `isHalted` skip in adopt (C02). |
| RTS-F6 ordering + shared-file collision | significant | C01 before C02; both centered on distinct functions; sequential, not parallel (both touch `squad-manager.ts`). |
| Verified-safe (do NOT over-fix) | — | reconnect+adopt cannot double-handle (`!rosterIds.has`); reap does not kill the just-reconnected `-wf` host; gate routing + merge vars already persist. Store DB/file parity is fine. |

## Open Questions
None blocking. Two deferred-by-decision: robust socketless-process reaping (RTC-F8 beyond the index-lock
guard) and the half-dead reattach deadline (RTC-F9) are explicitly out of scope for this plan.
