# Design: Archil as the collaborative agentic-OS substrate — pilot

> Chained from `/research https://docs.archil.com`. Arbitrated after a 2× opus red team
> (`history://RedTeamCorrectness`, `history://RedTeamScopeValidity`), then **reframed** after the operator
> clarified the target: not a faster worktree backend on one machine, but a **cohesive collaborative HITL
> agentic operating system** where multiple agents AND humans operate one shared code substrate and agentic
> work is *factorized* (forked/merged) into units of expression.

## The reframe (what changed and why)

The original gate asked "is FUSE latency ≤ 1.5× local NVMe for one worktree's git+build storm?" — Archil as a
local-disk replacement. **Wrong axis.** Archil's actual product is a collaborative substrate, and its docs say
so: shared disks (multi-client mount; multi-agent-systems guide: "persistent memory + stateless agents sharing
state across servers"), branches/checkpoints (COW forks = the factorization primitive), and "mount the same
disk from a laptop to inspect what the agent has been doing" (HITL co-access, read-after-write consistent).

Consequences:
- **Latency is demoted from go/no-go to a characterized constraint.** Sub-ms cached is fine for interactive /
  shared-memory access; hot build scratch can stay off the synced substrate. Measure it to inform layering;
  don't gate on it.
- **The gate becomes consistency/ownership under concurrent multi-client access** + whether branches/
  checkpoints cleanly model fork→explore→HITL-review→converge. (Concern 02, rewritten.)
- **Pilot scope flips from "exclusive mount, no `--shared`, no branches" to shared mode + branches** — those
  are the primitives under test. The red team's shared-mode hazards (checkout/checkin ownership, `--force`
  EIO, stale-for-seconds reads) stop being "avoid" and become "the thing we characterize."
- **Branches are now first-class**, not dismissed.

What did **not** change: durability is no-regret in either framing — concerns 01 (fsync) and 03 (unclean-stop
durability) stand as-is.

## Pilot scope (hard boundaries)

- **No production integration code.** No `OrgStorage`/`ArchilStorage` seam, no registry wiring, no eviction/
  unmount lifecycle. Those are the *payoff*, built only in a follow-up justified by a green gate.
- **Throwaway spikes on human-provisioned disks** produce the decision. The fleet builds the harness/test code
  + the one no-regret durability fix; a human supplies `ARCHIL_*` creds + disk(s) for the live characterization.
- **Single daemon for now.** Multi-host placement of agents across VMs (which branches enable) is acknowledged
  as the direction but is not built or load-tested here.

## Approach (3 concerns)

**01 — fsync durability hardening (no Archil dependency; correct on local disk too).** The persistence layer
never invokes the durability barrier: `FileStore.save` is `writeFile(tmp)+rename` with **no fsync**
(store.ts:75-84), `DbStore.saveTranscripts` identical (store.ts:229-238), `appendReceipt` bare `appendFile`
(receipts.ts:163). Add one durable-write helper (`open→write→fsync→close→rename→fsync(dir)`) and route the
three writes through it. The one piece of real code that earns its place before the gate.

**02 — Collaboration + factorization spike — THE GATE (reframed).** On a provisioned disk: mount `--shared`;
N agent-workers each `checkout` a disjoint subtree/branch and run a git-status storm + writes while a second
"human" client mounts and inspects — record ownership conflicts, dynamic-ownership on new dirs, observed
staleness windows, any EIO/ESTALE (NO `--force` in the baseline). Then exercise the factorization primitive:
checkpoint a base, fork a branch per expression unit, mutate, checkpoint, mount a branch on a second client
(HITL review), merge/promote one back. Characterize latency (concurrent, cold, git-metadata isolated) as data
feeding the layering decision. **GO iff** N agents + 1 human co-access works with a workable ownership model
(disjoint-subtree writes don't serialize the fleet; staleness tolerable on review; no silent corruption/EIO
non-`--force`) AND branch/checkpoint/merge cleanly expresses fork→explore→review→converge AND a layout keeping
latency acceptable is identified. Not a fixed latency threshold.

**03 — Durability across an UNCLEAN stop (depends on 01).** A clean unmount flushes, so a clean cycle is a
false green. Write real `state.json` + transcripts + receipts + a worktree, `fsync`, **`kill -9` (no clean
unmount)**, remount, assert the last committed persist + worktree survived. Locally validates 01's fsync
crash-survival (engineering-ready); the real-Archil remount needs creds (external-dep).

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| What the gate measures | consistency/ownership under concurrent multi-client access + factorization-primitive fit | The target is a collaborative substrate, not a worktree backend; single-client latency is the wrong axis. |
| Latency | characterized constraint, **not** a pass/fail gate | Sub-ms cached suffices for interactive/shared-memory; heavy build scratch stays off the synced substrate. |
| Mount mode | `--shared` multi-client + branches **in scope** | These are the primitives the agentic OS needs; the spike tests their ownership/consistency model. |
| Factorization primitive | branches/checkpoints (first-class) | "Factorization of agentic expression" = branch-per-exploration, checkpoint-per-decision, merge-on-HITL-approve. |
| Pilot shape | throwaway spikes + one fsync fix; **no seam** | Go/no-go needs zero production code; a seam shipped ahead of the gate is a dead abstraction in an autonomous fleet. |
| Durability | fsync (01) + unclean-stop test (03), unchanged | No-regret; an agentic OS that loses committed expression on a crash is broken. |

## Confirmed topology (operator-confirmed)

**Branches/checkpoints are MUTUALLY EXCLUSIVE with S3-sync on a single disk.** Decision: the **layered model**
— synced **trunk** disk = durable shared substrate (in your S3 bucket, no lock-in); non-synced **branched**
disks = ephemeral per-agent / per-exploration COW forks, promoted into the trunk on HITL merge. **HITL
co-access = both**: control-plane UI to steer (omp-squad mediates substrate r/w) + optional live-mount to
debug. Concern 02 **validates** this end-to-end (fork on a branched disk → UI + live-mount review → land onto
the synced trunk), rather than choosing among topologies.

## Risks

1. **Concurrency/ownership model too coarse** (critical, the new gate) — if `checkout`/`checkin` serializes
   agents that touch overlapping dirs, or staleness breaks the human review path, the collaborative model
   fails. Concern 02 characterizes this.
2. **No-fsync crash window** (critical) — fixed by 01, proven by 03's `kill -9`.
3. **branches XOR S3-sync forces a topology choice** (significant) — resolved by the layering decision in 02.
4. **Hard new runtime + network dependency** (significant) — pilot is throwaway + opt-in; nothing ships into
   file mode or the registry.
5. **Cost** (moderate) — non-synced branches are COW (delta-billed); synced trunk + N full worktrees are not.
   Concern 02 reports active-GiB under both.

## Red Team Concerns Addressed (still valid post-reframe)

| ID | Concern | Resolution after reframe |
|---|---|---|
| B | No fsync → clean-unmount masks crash window | Concern 01 adds fsync; concern 03 uses `kill -9`, not a clean cycle. |
| B1–B4 | Latency harness shape (single-stream/warm/unpinned) | Reused as the *constraint-characterization* sub-part of concern 02 (concurrent, cold, git-metadata isolated, layout pinned) — now feeding the layering call, not a gate. |
| B5 | No pre-registered pass/fail | Concern 02 has an explicit reframed GO rule (collaboration/consistency, not latency). |
| H1 | `checkout`/shared-mode = multi-writer opt-in | **Deliberately in scope now** — the spike's purpose is to characterize the shared-mode ownership protocol. |
| A | Eviction unmounts disk under a live host | Deferred (no unmount lifecycle in the pilot); the production seam keeps disks mounted for daemon lifetime / kills+confirms before release. |
| C/D/E | acquire rollback / mount-ready barrier / token source | Deferred to the production-seam follow-up. |
| F | Isolation claim overstated | Stays downgraded: Archil isolates at-rest/cross-machine; in-process isolation is unchanged path-discipline. |
| V1/V2 | worktrees aren't COW / branches dismissed | Corrected — branches are now the first-class factorization primitive; the branches-vs-sync tradeoff is the central fork. |

## Deferred to the green-light follow-up (built ONLY if concern 02's gate passes)

The production substrate: the trunk/fork disk topology from 02's layering decision; `OrgStorage`/`ArchilStorage`
wiring (shared mount, keep-mounted-for-daemon-lifetime, acquire rollback [C], mount-ready barrier [D], token
source [E]); the branch/checkpoint ↔ agentic-expression mapping in the control plane; HITL review surfaced in
the omp-squad UI. None built now.

## Resolved (operator-confirmed)
- **Layering:** layered — synced trunk + non-synced branched forks (promoted on HITL merge).
- **HITL co-access:** both — control-plane UI to steer + optional live-mount to debug.
