# Collaboration + factorization spike — shared-substrate consistency gate
STATUS: blocked
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: scripts/collab-spike-archil.ts, docs/archil-pilot.md
PLANE: OMPSQ-74 — https://app.plane.so/inkwell-finance/browse/OMPSQ-74/
PARKED: operator chose to wait on a paid Archil account. The live `--shared` + branches characterization
cannot run without a provisioned disk; the harness/local-dry-run could be built but is low-value standalone,
so the whole concern is parked in Backlog. Un-park: docs/archil-pilot.md.

## Why this replaced the latency benchmark

The original concern gated on "is FUSE latency ≤ 1.5× local NVMe for one worktree's git+build storm" —
Archil-as-local-disk-replacement. **Wrong axis.** The target is a cohesive collaborative HITL agentic OS:
multiple agents AND humans operate one shared code substrate, and agentic work is *factorized* into
forkable/mergeable units of expression. Archil's own product matches that vision exactly:
- **Shared disks** — multiple clients mount one disk simultaneously (multi-agent-systems guide: "persistent
  memory + stateless agents sharing state across servers", `--shared`).
- **Branches & checkpoints** — COW forks of the whole workspace = the factorization primitive.
- **HITL co-access** — "mount the same disk from a laptop to inspect what the agent has been doing"
  (bash-tool guide), read-after-write consistent with the agent's writes.

Under this frame single-client latency-vs-NVMe is a **constraint to characterize, not the go/no-go**. The
go/no-go is whether the shared-substrate + branch model holds up under concurrent agent + human access.

## Goal

Decide whether Archil's collaborative substrate supports the agentic-OS workflows, on three axes:

1. **Consistency / ownership under concurrent multi-client access (THE gate).** With `--shared`, exactly one
   client may write a given file/dir at a time (`checkout`/`checkin`, or dynamic ownership for new paths);
   cross-client reads can be stale for *seconds* until revalidation; `--force` revokes ownership and causes
   `EIO` on the loser's unflushed writes. Question: can N agents + 1 human co-access one disk where agents
   write **disjoint subtrees** (one branch/dir per agent's expression) without serializing the fleet, with
   staleness tolerable on the human review path, and **no silent corruption / no EIO** under normal
   (non-`--force`) operation?
2. **Factorization primitive fit.** Do branches/checkpoints cleanly express *fork agentic expression → explore
   → HITL review → converge/merge*? Branch-per-exploration, checkpoint-per-decision, merge-on-approve. Does
   the branch tree map onto the agentic-expression DAG, and can a human diff/approve a checkpoint?
3. **Latency as a characterized constraint (not a gate).** Measure concurrent/cold behavior (reuse the
   N∈{1,4,8,16} + cold-cache + git-metadata-isolation shaping from the prior red team) to *inform the layering
   decision below* — e.g. keep hot build scratch off the synced substrate. Report it; do not pass/fail on it.

## Approach

`scripts/collab-spike-archil.ts` — a spike (throwaway), not production code. On a human-provisioned disk:

- **Shared multi-client co-access:** mount the disk `--shared` from the daemon; spawn N worker processes each
  `checkout`-ing its own subtree/branch and doing a git-status storm + writes; concurrently have a second
  "human" client mount the same disk and read/inspect. Record: ownership conflicts, dynamic-ownership behavior
  on new dirs, staleness windows observed (write on client A → visible on client B after how long), and any
  `EIO`/`ESTALE`. **No `--force`** in the baseline (that's the data-loss path; test it separately and label it).
- **Factorization on the layered topology:** start from the synced **trunk** disk; fork a **non-synced
  branched disk** per "agentic expression" unit; mutate each independently; checkpoint. **HITL review in both
  modes:** the control plane reads the branch for UI-mediated review AND a human can live-mount the branch to
  inspect (Archil "mount the disk to see what the agent did"). On approve, **promote/land the branch result
  onto the synced trunk** (e.g. `archil.exec` with trunk + fork both mounted). Record whether fork→review→land
  is clean or manual.
- **Latency characterization:** the concurrent/cold measurements, reported as data (per-N p50/p99, git-op line
  items, post-remount time-to-first-op, active-GiB), feeding the layering call — not a threshold.

**Harness is engineering-ready; the behavior needs real Archil (`--shared` + branches → creds + a disk).**
Build + dry-run the orchestration locally; report the creds blocker for the live characterization. **Never
fabricate a result.**

## Gate (reframed — replaces the latency threshold)

```
GO iff ALL of:
  - N agents + 1 human co-access one --shared disk with a workable ownership model: concurrent writes to
    DISJOINT subtrees do not serialize the fleet; cross-client staleness is tolerable on the HITL review path;
    NO silent corruption / NO EIO under normal (non --force) operation.
  - branch/checkpoint/merge cleanly expresses fork → explore → HITL review → converge for one expression unit.
  - a disk layout/layering is identified that keeps latency acceptable under concurrent access.
```

## Confirmed topology (this spike validates it; operator-confirmed)

**Branches/checkpoints are MUTUALLY EXCLUSIVE with S3-sync on a single disk.** Operator decision: the
**layered model** — a **synced "trunk" disk** = the durable shared substrate (lives in your S3 bucket, no
lock-in); **non-synced branched disks** = ephemeral per-agent / per-exploration COW forks, promoted into the
trunk on HITL merge. **HITL co-access is both**: humans normally steer through the omp-squad control-plane UI
(which reads/writes the substrate) and may also live-mount a disk to debug. The spike's job is to **validate**
this layering end-to-end (fork on a branched disk → UI + live-mount review → land onto the synced trunk), not
to choose it. Flag any place the layering breaks (e.g. promote/merge across disks is manual or lossy).

## External dependency
Real `--shared` mount + branches/checkpoints → an Archil account + a provisioned disk + `ARCHIL_*` + an AWS
region. Harness/orchestration + the local dry-run are engineering-ready; the live characterization is blocked
on creds (report it; do not fake).

> `.env.example` gotcha unchanged: pilot `ARCHIL_*` are read in `scripts/`, not `src/` — document in
> `docs/archil-pilot.md`, do not add to `.env.example` (would break `tests/env-example.test.ts`).

## Verify
- `bun scripts/collab-spike-archil.ts` runs the orchestration against a local dry-run (N workers + branch ops
  simulated on local dirs/git) and emits the report skeleton; the live `--shared`+branches characterization is
  produced when creds are present, else reports the creds blocker.
- `docs/archil-pilot.md` documents the shared-mount + branch/checkpoint procedure, the ownership model
  observed, the latency characterization, and the trunk/fork layering decision.
- The spike ends in a written GO/NO-GO against the reframed gate + a layering recommendation.
