# Inspectable topology — overview

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural

## Goal

The fleet's actual run topology becomes one queryable, restart-surviving tree:

1. One lineage schema — every child run (omp-native subagent AND workflow branch agent) persists parent run id + parent node id at spawn; the `SubagentTracker` tree is flushed to durable storage instead of living only in process memory; the webapp renders one unified parent/child tree.
2. The static workflow graph is journaled once per run (`workflow.graph`, with nodes/edges/conditions/budgets) before the first node executes, so the UI can render intended topology with live progress overlaid instead of only ever showing "where the run currently is."

## Why (source)

`plans/research-burr/BRIEF.md` (Apache Burr research) plus a two-round adversarial red-team on the initial draft design. The full code-verified landscape, every keyDecision, and every resolved red-team finding are recorded in the arbiter's final design (see the decomposer prompt / commit history for `research-burr`) — this overview does not repeat them; each concern below carries only what its implementer needs, with exact line numbers verified against the current tree at decomposition time.

## Concern order (sequential — each depends on the previous)

1. **01-boot-path-threading-and-durability.md** [p0, gates everything] — `parentNodeId`/`branchIndex`/`subagents`/`workflowGraph` fields threaded through `CreateAgentOptions`/`PersistedAgent`/`AgentDTO` and all four boot-path reconstruction sites (`create()`, `adoptOrphanedAgents`, `loadPersisted`, `attachExisting`), each with a round-trip acceptance test. Same slice replaces `persist()`'s always-chain writer with a chain-dedup (≤2 writes per burst, durability barrier preserved) and makes `FileStore.save()`'s currently-silent failures visible (rate-limited warn + counter on `factory-status`).
2. **02-subagent-merge-flush-lineage.md** [p0] — `SubagentTracker` gets transition-based dirty tracking (not lifecycle-frame-gated, to avoid losing a terminal status to a race), a merge-by-id flush (`mergeSubagents()`, never an overwrite), reseeding on reattach/adopt via the previously-dead `applySnapshot`, and run-end/restart closure so no persisted node can claim "running" under a stopped agent forever. One projection backs both the persisted snapshot and every live reader. Depends on 01's `subagents` field/threading.
3. **03-workflow-graph-journal.md** [p1] — `WorkflowGraphSnapshot` (version:1, includes `retryTarget` as a dashed failure edge), emitted at the top of `execRun` (after the real `runId` is assigned — not in `start()`, which stamps a bogus pending id and misses resumed/second runs) via a new `workflow_journal`/`workflow.graph` case that returns early like the existing `subagent_` branch. Also threads `parentNodeId`/`branchIndex` from `BranchSpec` through `spawnFleetBranch` to `create()`. Depends on 01's `workflowGraph` field/threading and the `parentNodeId`/`branchIndex` fields.
4. **04-webapp-topology-view.md** [p1, drill-in is the designated cut] — `webapp/src/lib/dto.ts` mirror fields (today it's missing `parentId`/`kind`/`workflow`/`workflowState` entirely), a ported lineage-forest builder (`buildLineageTree`, direct port of the legacy `src/web/index.html:1323-1325` root/child split with an explicit orphaned-root badge), a workflow graph overlay (`buildWorkflowFlow`, layered layout in the spirit of `planGraph.ts`), and — if time allows — a rollup-first trace drill-in redesign with a server-side per-runId cache in front of the unbounded `readAllReceipts` scan. Depends on 01-03 for real server-side data to render.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01-boot-path-threading-and-durability.md | — | — |
| 02-subagent-merge-flush-lineage.md | 01-boot-path-threading-and-durability.md | `grep -c 'subagents' src/types.ts` > 0 (concern 01's fields exist) |
| 03-workflow-graph-journal.md | 01-boot-path-threading-and-durability.md | `grep -c 'workflowGraph' src/types.ts` > 0 |
| 04-webapp-topology-view.md | 01, 02, 03 | `grep -c 'workflowGraph' src/squad-manager.ts` > 0 (concern 03's onAgentEvent case exists) |

## Explicit scope cuts (do not build in this slice)

- General `WorkflowJournalEvent` persistence (a durable log of every journal event type, not just `workflow.graph`) — the brief's separate hooks-convergence initiative.
- Per-run lineage tombstones for pre-crash branch children excluded from adoption (`spawn-identity.ts:28-31`'s double-land guard) — the roster tree stays *live* topology; dead branches remain reachable as history via the existing trace drill-in (`buildTrace` already links by receipt `parentId`). A tombstone store is the named follow-on if the drill-in proves insufficient.
- Trace sample-ratio policy changes (`traceSampleRatio()` / `OMP_SQUAD_TRACE_SAMPLE`) — a telemetry-policy decision, not a topology-slice decision.
- `DbStore` per-flush cost upgrade (diff-upsert instead of full delete+insert) — chain-dedup (concern 01) caps write *rate*, not per-write cost; a db-mode-at-scale upgrade is flagged in `src/dal/store.ts`'s own "ponytail" comment and is out of scope here.

## Cross-plan overlaps (for anyone running these plans in parallel)

- **lifecycle-truth** (`plans/lifecycle-truth/`) touches `src/squad-manager.ts` + `src/types.ts` + `src/dal/store.ts` — the same three files concern 01 here touches. Lifecycle-truth's `transition()`/`setPending()` guard and this plan's boot-path field threading are independent edits to disjoint regions of `squad-manager.ts` (status-write call sites vs. `create()`/`adoptOrphanedAgents`/`loadPersisted`/`attachExisting`), but land them serially (rebase, don't run both in-harness on the shared tree simultaneously) since both touch `AgentDTO`/`PersistedAgent` in `types.ts` and both touch `persist()`'s neighborhood in `squad-manager.ts`.
- **never-lose-work** (if/when that plan exists) touches `src/workflow/*` + `src/workflow-driver.ts` — the same files concern 03 here touches (`execRun`, `WorkflowJournalEvent`, `WorkflowRunState`). Coordinate before both land against `workflow-driver.ts:216-247`.
- This plan (**inspectable-topology**) touches `src/subagents.ts`, `src/receipts.ts` (read-only reference for the rollup/redact discipline concern 02 and 04 mirror, no edits), `src/dal/store.ts`, `src/workflow-driver.ts`, `src/workflow/types.ts` — flag any concurrent plan editing those files before dispatching.

## Outcome

- One roster snapshot, one lineage schema: every child agent (subagent or workflow branch) is findable from its parent's id, structurally (not just by matching a mutable display name), and survives a daemon restart.
- The subagent tree is durable and restart-surviving — no persisted "running" lies, no lost terminal status to a frame-ordering race, one read contract for both the live poll endpoint and the persisted snapshot.
- Every workflow run has exactly one `workflow.graph` journal event with a correct `runId`, so the webapp can draw the intended graph with live progress overlaid instead of only a linear "current node" view.
- The live webapp (not just the legacy fallback page) renders the unified parent/child forest and the workflow graph overlay, with an honest (rollup-first, sampling-labeled) trace drill-in.

## Notes

- /plan Phase 0 snapshot (headless chained run): proceeded over 3 plans with open concerns (agentic-learning-loop 5, factory-control-plane 3, change-driven-loops 2; all last-touched 2026-07-03).

## Completion
4/4 concerns closed 2026-07-04 on feat/inspectable-topology (stacked on feat/never-lose-work on feat/lifecycle-truth). Suite 1179→1221 root + 334→366 webapp, tsc clean. One workflow harness death mid-run (concern 02's report lost) recovered via post-hoc review — PASS, nothing half-done. Post-batch audit: /code-review high (10 confirmed defects incl. a cross-tenant traceCache leak and a false-stall lastActivity regression) + fable cross-batch audit (SHIP + the subagents-never-rendered honesty gap) — all 14 fixed; independent re-review across 8 regression areas: SHIP. Deferred (DESIGN-accepted): tombstone store, general journal persistence, DbStore diff-upsert, trace sample policy; new: per-status color-class test assertions in TopologyPanel (cosmetic).
