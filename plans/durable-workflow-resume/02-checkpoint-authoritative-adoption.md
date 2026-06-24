# Checkpoint-authoritative, loss-free adoption
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, tests/adopt-cap.test.ts, README.md
BLOCKED_BY: 01-sound-cold-resume.md
VERIFY_BLOCKER: `grep -n "cold" src/workflow/executor.ts` shows the cold-resume re-run branch — C01 must have landed so the runs this concern makes eligible resume soundly.

## Goal

Make a persisted `workflowState` checkpoint the authoritative signal that a workflow run is resumable, and
guarantee the checkpoint **survives** a restart instead of being erased — so no in-flight graph run is
silently lost. Also stop adoption from mis-landing partial or branch worktrees.

## Approach

All in `src/squad-manager.ts`, centered on `adoptOrphanedAgents` (`474-511`) and the persist path.

**1. Eligibility — checkpoint counts as work.**
The `hasWork` predicate fed to `selectAdoptable` is `persistedHasWork(p)` (worktree dirty/ahead, `515-522`).
OR-in a resumable checkpoint:

```ts
const resumable = (p) => p.kind === "workflow" && p.workflowState !== undefined;
const work = new Map<string, boolean>();
for (const p of eligible) work.set(p.id, resumable(p) || await this.persistedHasWork(p));
```

**2. Preserve, don't erase — the real D1 fix (RTS-F1).**
A checkpointed workflow dropped by the ceiling is currently *erased*: `persistNow` serializes only the live
roster (`1960`) and `store.save` is a full-snapshot replace (`store.ts:118-124,179-200`), so the first
`create()`/poll/stop flush overwrites it. Keep the un-adopted eligible checkpointed records and fold them
into the persisted roster so a later (routine) restart re-attempts them:

```ts
// in adoptOrphanedAgents, after selecting `adopt`:
const dropped = eligible.filter((p) => resumable(p) && !adopt.includes(p));
this.deferred = dropped;   // PersistedAgent[] kept across this boot
// in persistNow (~1960): merge live roster options with this.deferred, dedup by id
const agents = dedupById([...this.agents.values().map(r => r.options), ...(this.deferred ?? [])]);
```

This removes silent permanent loss **without touching the OOM ceiling** (the daemon is crash-supervised;
restarts are routine — `orchestrator-state.ts:5-9`). `ponytail:` next-boot pickup; upgrade path = enqueue
over-ceiling resumable adopts into the existing admission `Scheduler` (`orchestrator.ts:242-247`) for
gradual within-boot drain. With records preserved, the draft's "sort workflows ahead of plain agents"
ordering is unnecessary — **do not add it** (probabilistic band-aid, RTS-F1).

**3. Never direct-land a workflow (RTC-F5, supersedes the weaker gate).**
`adoptOrphanedAgents` passes `adopted:true` unconditionally (`506`); for an idle adopted agent the
orchestrator lands directly, bypassing verify (`orchestrator.ts:196-204`). A resuming/partial workflow must
land only via its own `workflow_done → autoLandOnSuccess` (`1534-1538`):

```ts
adopted: p.kind !== "workflow",
```

**4. Don't independently land fan-out branches (RTC-F2).**
Each parallel branch is a real roster agent created with `parentId` set and its own worktree
(`spawnFleetBranch → create`, `~1146`). `agentsToAdopt` (`128-134`) does not exclude `parentId` children, so
orphaned branches get adopted as plain agents and direct-landed independently → double-land. Exclude them:

```ts
// in agentsToAdopt's filter
&& !p.parentId
```

A branch belongs to its parent run; the parent's resume re-drives the fan-out. (Also fixes the non-crash
leak where completed `wait_all` branches linger and become adoptable on the next restart.)

**5. Don't re-adopt halted runs (RTS-F5).**
A workflow the orchestrator escalated/halted is re-adopted every restart, burning a ceiling slot and a
resume attempt before the orchestrator re-skips it. Consult the existing restart-safe ledger:

```ts
const halted = openOrchestratorState(this.stateDir);   // already wired at squad-manager.ts:410
// in eligibility: skip p where p.branch && halted.isHalted(p.branch)
```

No new ledger.

## Cross-Repo Side Effects
None. Internal to omp-squad. Plain-agent adoption (the common path) is unchanged except for the `!parentId`
exclusion (branches were never independently landable by intent) and `adopted` staying `true` for non-workflows.

## Docs (ship with behavior — AGENTS.md rule)
README "Autonomy & orchestration" / restart section: a workflow with a checkpoint now resumes after a full
crash and is preserved across a ceiling-constrained restart (re-attempted next boot), and is never
direct-landed without completing its graph.

## Verify
Extend `tests/adopt-cap.test.ts` (pure-function tests over the exported `selectAdoptable` / `agentsToAdopt`,
no daemon, no model tokens):
- **checkpoint is work**: a `kind:"workflow"` record with `workflowState` set but no worktree work is
  eligible (the `resumable || persistedHasWork` predicate returns true).
- **preserve over ceiling**: with more resumable workflows than the cap, the un-adopted ones are returned in
  the `deferred` set (assert against a small pure helper that computes `dropped`), proving they are NOT
  silently discarded. A companion manager-level test (extend `tests/manager-autonomy.test.ts` or a focused
  fake) asserts a dropped checkpointed record still appears in the next persisted snapshot.
- **`!parentId` exclusion**: `agentsToAdopt` drops a record with `parentId` set even when its worktree exists.
- **workflow never adopted-landed**: the adopt `create()` for a `kind:"workflow"` passes `adopted:false`.
- **isHalted skip**: a record whose branch is halted is excluded from eligibility.
- Gate: `bun run check && bun test`.

## Release (dispatch after 01 lands green)
```bash
omp-squad add ~/sui/omp-squad --name loss-free-adopt --thinking high \
  --task "Implement plans/durable-workflow-resume/02-checkpoint-authoritative-adoption.md: in src/squad-manager.ts make workflowState authoritative for adoption eligibility, PRESERVE un-adopted checkpointed records through persistNow (deferred set), set adopted:p.kind!=='workflow', exclude parentId children in agentsToAdopt, skip isHalted branches, README + tests/adopt-cap.test.ts per the doc. Requires 01 (cold resume) already landed." \
  --verify "bun run check && bun test"
```
