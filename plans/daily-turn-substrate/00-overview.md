# Turn substrate (Epic E)

Parent: plans/daily-driver/00-meta.md · Design: plans/daily-driver/DESIGN.md · Arbitration: (scratchpad) daily-driver-arbitration.md §6/§7

## Outcome

A typed, fail-closed completion signal (quiesce events) replacing poll-and-guess async settling, a per-turn git checkpoint under every unit (not just workflow-kind agents), and a restore/fork path that never blind-checks-out onto a tree a human might be touching. Sequenced AFTER wave 1 (epics A-D) by PRIORITY, not BLOCKED_BY — it is not on the adoption path; its value is fleet-lane quality (verify-loop thrash, honest turn boundaries for the eventual needs-you ladder and true-in-place charters), not on-ramp adoption. Per 00-meta.md's kill criterion, this epic does not execute past authoring until the wave-1 adoption gate passes.

## Extends two CLOSED plans without reopening them

- **lifecycle-truth** (all 5 concerns CLOSED): this epic reuses its transitions/SquadEvent substrate (persisted transitions.jsonl, `{type:"transition"}` SquadEvent, SquadManager extends EventEmitter at squad-manager.ts:747) as the transport pattern for the new `quiesce` discriminant (01). It does NOT execute either of that plan's two named follow-ups: **transition-subscription** (maybePushAlert subscribing to the transition event instead of its private lastStatus-diff) ships in **plans/daily-attention-w0/02**, not here; **workflow_journal interleaving** remains unaddressed — out of scope for this epic, still open for whoever picks it up next. lifecycle-truth itself stays closed; nothing here reopens it.
- **never-lose-work** (all 5 concerns CLOSED): this epic executes BOTH of that plan's named follow-ups. **02-per-turn-checkpoint-refs** is the "generalize past kind:workflow" follow-up — checkpoint capture (today: src/workflow/checkpoint-log.ts, workflow-kind agents only, per-node boundary) extends to every unit's every turn. **04-orphan-sweep** is the "orphan sweep" follow-up — stateDir sweep for orphaned checkpoint-log files, extended to also sweep the new per-turn refs 02 introduces. never-lose-work stays closed; these are its own deferred children finally executed, not a reopening.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 quiesce-events | typed fail-closed completion signal (never confuse timeout with settled); first consumer replaces workflow executor's poll-and-guess idle loop | architectural | src/quiesce.ts (new), src/squad-manager.ts, src/server.ts, src/types.ts, src/workflow/executor.ts, src/dispatch.ts, src/autoland.ts, src/land.ts, scripts/defect-ratchet.ts |
| 02 per-turn-checkpoint-refs | generalize checkpoint capture past kind:"workflow" to every unit's every turn; fail-closed so dependents refuse on capture failure | architectural | src/squad-manager.ts, src/workflow/checkpoint-log.ts, src/worktree.ts, tests/ |
| 03 nondestructive-restore | restore/fork at turn granularity without ever blind-checking-out onto a live tree | architectural | src/squad-manager.ts, src/worktree.ts, webapp/src/components/, src/server.ts, tests/ |
| 04 orphan-sweep | never-lose-work's named follow-up: sweep orphaned checkpoint logs AND orphaned turn refs, with a justified retention policy | mechanical | src/workflow/checkpoint-log.ts, src/state-dir.ts, src/doctor.ts, tests/ |

## Order / batches

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | standalone — new module, no dependency on 02/03/04 |
| 2 | 02 | foundation for 03 and 04 (both need the turn-ref shape to exist) |
| 3 | 03, 04 | both depend only on 02, disjoint files (restore/fork UI vs. sweep maintenance pass) — parallelizable |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 quiesce-events | none | — |
| 02 per-turn-checkpoint-refs | none | — |
| 03 nondestructive-restore | 02 | `grep -n "refs/glance/checkpoints" src/squad-manager.ts` returns a match — the turn-ref cut exists for restore to resolve against |
| 04 orphan-sweep | 02 | same check as above — sweeping refs requires the ref namespace to exist first |

## Not yet specified

(none)

## Notes

- p2, architectural-heavy epic — cross-lineage review (codex + grok) applies to 01 and 02 as git-write / concurrency-adjacent paths, per 00-meta.md's model-routing decision (mandatory on any git-write path).
- Fail-closed discipline (00-meta.md: "absence of evidence is never evidence of settlement") is the spine of every concern here: 01's timeout-vs-settled distinction, 02's capture-failure-refuses-dependents, 03's never-blind-checkout, 04's dry-run-by-default sweep.
- The needs-you ladder charter (plans/daily-driver/01-charter-needs-you-ladder.md) and true-in-place charter (02-charter-true-in-place.md) both name prerequisites this epic partially satisfies (fail-closed checkpoint machinery for I; honest turn boundaries as raw material for H) — neither charter expands here; this epic just makes their eventual expansion possible.
