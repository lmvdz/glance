# Archil collaborative-substrate pilot

> **STATUS: PARKED** — decided and documented, **not provisioning**. We are deliberately not paying
> for an Archil account yet. This doc is the durable record of the research verdict, the architecture
> decision, and exactly how to un-park.
>
> Plan + concerns: [`plans/archil-mt-pilot/`](../plans/archil-mt-pilot/) · Tracker: OMPSQ-74/75/76 (Backlog).

## What Archil is

Elastic, S3-backed, POSIX file systems ("disks") that mount in ~100 ms, are **mountable on many clients
simultaneously** (`--shared`), can run commands serverlessly (`disk.exec`), and treat **the disk as the unit
of access isolation**. Branches/checkpoints are git-like copy-on-write forks of a whole disk. Docs:
<https://docs.archil.com>.

## The decision (and the reframe)

We first researched Archil as a *per-org storage backend* to harden omp-squad's multi-tenant isolation and
add durability — with **latency** (agent worktrees over FUSE/S3) as the gating risk.

The operator reframed the target: not a faster worktree backend on one machine, but a **cohesive collaborative
HITL agentic operating system** where multiple agents *and* humans operate one shared code substrate, and
agentic work is **factorized** (forked/merged) into units of expression. Archil's own product is built for
exactly this — its guides cover "persistent memory + stateless agents sharing state across servers" and
"mount the same disk from a laptop to inspect what the agent has been doing."

**Consequence:** the latency-vs-local-NVMe benchmark measured the wrong axis. It is replaced by a
collaboration gate, and latency is demoted to a characterized constraint.

## Confirmed architecture

- **Gate:** consistency/ownership under concurrent multi-client access (does `--shared` + `checkout`/`checkin`
  let N agents + a human co-edit disjoint subtrees without serializing the fleet or reading stale state?) plus
  whether branches/checkpoints cleanly model *fork → explore → HITL review → converge/merge*. **Not** a latency
  threshold.
- **Topology (operator-confirmed): layered.** A **synced "trunk" disk** = the durable shared substrate (lives
  in your own S3 bucket, no lock-in). **Non-synced branched disks** = ephemeral per-agent / per-exploration
  COW forks, promoted into the trunk on HITL merge. (Branches and S3-sync are *mutually exclusive on one disk*,
  which is why the model is layered rather than a single disk.)
- **HITL co-access (operator-confirmed): both.** Humans steer through the omp-squad control-plane UI (which
  mediates substrate reads/writes) and may also live-mount a disk to debug.
- **Durability is no-regret** and survives in either framing: fsync the persistence layer (OMPSQ-75) and prove
  committed work survives an unclean stop (OMPSQ-76).
- **Cost model:** $0.20 / GiB-month of *active* data (1 hr active window); branches are COW (delta-billed).

## Work items (all PARKED in Backlog)

| Issue | What | Needs a paid account? | Notes |
|---|---|---|---|
| **OMPSQ-75** | fsync durability hardening of the persistence layer | **No** | Free, no-regret crash-safety; correct on local disk. Promote to Todo anytime, independent of the Archil decision. |
| **OMPSQ-74** | Collaboration + factorization spike (the gate) | Yes (for the live characterization) | Harness/local-dry-run is buildable; the real `--shared` + branches run needs a provisioned disk. |
| **OMPSQ-76** | Durability across an unclean stop (`kill -9` + remount) | Partly | Local crash-survival is free (validates OMPSQ-75); the real remount leg needs a disk. Blocked by OMPSQ-75. |

The deferred *production* `OrgStorage`/`ArchilStorage` seam is built only if OMPSQ-74's gate goes GREEN.

## What we are NOT doing now

No Archil account, no provisioned disks, no paid usage, no production seam, no auto-dispatch of these issues
(they sit in Backlog so the fleet does not pick them up).

## Env config (forward-declared in `.env.example`, commented/parked)

```
ARCHIL_DISK=            # synced "trunk" substrate disk name/id
ARCHIL_REGION=          # aws-us-east-1 | aws-us-west-2 | aws-eu-west-1
ARCHIL_MOUNT_TOKEN=     # disk token for `archil mount` (SDK also reads ARCHIL_DISK_TOKEN)
```

These are read by `scripts/` pilot scripts when un-parked, **not** by `src/`. Left commented until a paid
account exists.

## To un-park

1. Provision a paid Archil account + a synced **trunk** disk (and pick an AWS region).
2. Set `ARCHIL_*` in your local `.env`.
3. Promote the issues in Plane: OMPSQ-75 (free, do it regardless) and OMPSQ-74 (the spike) from Backlog → Todo.
4. The fleet builds the harness, runs the spike, and records a written GO/NO-GO + layering confirmation.
5. **If GO:** start the deferred production follow-up (the `OrgStorage`/`ArchilStorage` seam on the layered
   trunk/fork topology). **If NO-GO:** keep local storage; OMPSQ-75's fsync hardening stays as a standalone win.

## Note: `.env.example` was being eaten by `.gitignore`

`.gitignore`'s `.env.*` pattern matched `.env.example`, so the example was ignored, never tracked, and removed
on `git clean` (this is why it kept vanishing). Fixed by adding `!.env.example`. Keep `.env.example` **committed**
so it survives resets — a fresh clone needs it for the onboarding the README describes.
