# Orphan sweep — checkpoint logs and turn refs

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/workflow/checkpoint-log.ts (checkpointLogPath, existing orphan target), refs/glance/checkpoints/* (concern 02's output, new orphan target), src/state-dir.ts (stateDir sweep root), src/doctor.ts (sweep sub-check host, existing `glance doctor` precedent), tests/ (new fixture stateDir + fixture repo)
BLOCKED_BY: 02

## Goal

Execute the never-lose-work plan's own named follow-up, in full: sweep `stateDir` for orphaned workflow-checkpoint-log JSONL files (`checkpointLogPath`, src/workflow/checkpoint-log.ts) belonging to deleted/unknown units, AND — new, since concern 02 introduces the artifact — sweep orphaned per-turn refs (`refs/glance/checkpoints/<unitId>/<turnN>`) for units that no longer exist. Ship a justified retention policy so sweeping never destroys a checkpoint a human might still want.

## Approach

- **Two orphan classes, one sweep pass:**
  1. `<stateDir>/workflow-checkpoints/<runId>.jsonl` files whose `runId` has no corresponding known unit (cross-reference against the durable set of known unit ids — transitions.jsonl's id set, or the agent/project registry — not an in-memory-only list, since the sweep must work correctly after a restart).
  2. `refs/glance/checkpoints/<unitId>/<turnN>` git refs (enumerate via `git for-each-ref refs/glance/checkpoints/` per managed repo — refs are per-repository, so each repo's `.git` namespace gets its own sweep pass, not one global pass) whose `unitId` has no corresponding known unit.
- **Retention policy (author-proposed, justified here — not left open):** keep orphaned checkpoints for a bounded grace window (recommend 7 days past the unit's deletion/last-seen timestamp) rather than sweeping immediately on unit deletion. Justification: a human may delete a unit by mistake, or want to recover a checkpoint shortly after deletion — the never-lose-work plan's own name is the argument for erring toward the longer grace window whenever the tradeoff is ambiguous, while a fixed TTL still bounds unbounded accumulation. The window is a single configurable constant (not hardcoded across two call sites) so it can be tuned without touching sweep logic.
- **Entry point:** a `glance doctor` sub-check (src/doctor.ts, following the existing `doctor` precedent already shipped) that reports orphan counts (both classes, split by age above/below the retention window) by default — dry-run first, never destructive by default, matching 00-meta.md's fail-closed-everywhere discipline. An explicit flag (e.g. `--sweep`) or confirm prompt is required to actually delete anything past the grace window.
- Scope discipline: this concern only reads and (optionally) deletes already-written artifacts from concerns 01/02 (indirectly, via the checkpoint-log and ref namespaces they produce) — it does not modify capture logic (02) or the quiesce bus (01).

## Cross-Repo Side Effects

none — each managed repo's own refs/checkpoint-log namespace is swept independently per-repo/per-stateDir; no cross-repo coordination required.

## Verify

- Test: a workflow-checkpoint-log file for a genuinely deleted/unknown `runId` is correctly flagged orphaned; a file for a live/known `runId` is not.
- Test: a `refs/glance/checkpoints/<unitId>/*` ref for a deleted unit is correctly flagged orphaned; refs for live units are not.
- Test: retention window is honored — an orphan younger than the grace window is reported but NOT deleted even when `--sweep` is passed; only orphans past the window are deleted.
- Test: dry-run (the default, no `--sweep`) never deletes anything — assert file/ref counts are unchanged after a dry-run pass over a fixture `stateDir` + fixture git repo seeded with planted orphaned and live artifacts of both classes.
- All under `bun test`, exercised against fixtures — never against the real `~/.glance` state dir.
