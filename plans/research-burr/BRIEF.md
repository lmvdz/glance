# Research Brief: Apache Burr → omp-squad

- **Date**: 2026-07-03
- **Target project**: omp-squad (glance) — Bun/TypeScript autonomous agent factory
- **Research target**: https://burr.apache.org/docs/ — Apache Burr (Incubating), Python state-machine framework for stateful AI apps
- **Verdict up front**: do NOT adopt the dependency (Python; and our workflow engine already beats its checkpoint model). Borrow 7 patterns, ranked below. Top two: fork-from-checkpoint and a guarded single write-path for agent status.

---

## Phase 1 — Scout: what Burr is

Apache Burr (originally DAGWorks, now Apache Incubating, ~v0.42.0) is a dependency-free Python framework that models stateful AI applications as **explicit state machines**: actions (nodes) declaring `reads`/`writes` over a single **immutable** state object, connected by ordered conditional transitions, with built-in persistence, a tracking UI, and human-in-the-loop support.

### Core mechanisms

1. **State**: immutable; only derivable (`update/append/increment/wipe`). Per-field/per-type serde registry; built-in persisters require JSON-serializable state.
2. **Actions**: declare `reads=[...]`, `writes=[...]`. Each step the framework "checks out" only the declared read subset, runs the action, merges the partial update back — a commit/checkout/merge model (git-like). Prevents undeclared side effects; actions are unit-testable in isolation.
3. **Transitions**: `when(key=value, key__gt=...)`, `expr('epochs>100')`, `default`. Evaluated in declared order, first true wins; **no match ⇒ halt with warning** (loud, not silent).
4. **Application loop**: `step()/iterate()/run()/stream_result()` (+ separate async twins). `halt_before`/`halt_after` lists are the whole human-in-the-loop story — **pause is just a halt condition + persistence-based resume**, not a special interrupt primitive.
5. **Persistence**: pluggable `BaseStatePersister` keyed by `(partition_key, app_id, sequence_id, position)`, every save carries status `"completed"|"failed"`. `initialize_from(...)` resumes; **forking** (`fork_from_app_id/partition_key/sequence_id`) starts a *new* `app_id` with state copied from any checkpoint of a prior run, prior run untouched — designed for rewind-and-try-a-different-path debugging. The tracking store itself can serve as the fork loader.
6. **Tracking**: `LocalTrackingClient` is implemented purely as public lifecycle hooks (`pre_run_step`/`post_run_step`/`post_application_create`) — the official UI backend consumes the same hook API users extend. Data model: Project → Application (≈trace) → Step (name, inputs, full state at execution, timestamps). `post_application_create` logs the **static graph + source code once** per app. Burr UI (port 7241) renders graph + step history. OTel opt-in. Hook execution order is explicitly undefined (their confessed wart).
7. **Recursion/sub-agents**: admittedly provisional — child app built manually inside a parent action, `tracker.copy()` + `with_spawning_parent(parent_app_id, parent_sequence_id)`; UI renders the parent/child tree. **Parallelism** (`MapStates`/`MapActions`) sits on the same machinery with **deterministic child app_ids derived from parent context + task index ⇒ partial-completion resume of a fan-out**.
8. **Positioning** (their table): vs Temporal — durability but no explicit state machine; vs LangGraph — no open-source UI; vs plain code — no free observability/persistence/replay/pause-resume.

### Design tensions Burr accepted

- Explicitness tax (declare everything up front) in exchange for auditability/replay/static visualization.
- Immutable-state copy overhead in exchange for well-defined diffs and forking.
- Single local tracking backend (filesystem `~/.burr`) today.
- Sync/async as two full parallel API families (Python problem; irrelevant to Bun).
- Recursion left half-solved on purpose, pending a real construct.

Sources: burr.apache.org/docs concepts pages (state, actions, transitions, state-persistence, tracking, hooks, recursion, parallelism, streaming, serde, sync-vs-async), reference (application, persister, tracking, integrations), github.com/apache/burr README. No llms.txt exists on the site.

---

## Phase 1b — Scout: omp-squad's current shape (code-verified)

1. **Agent lifecycle state**: no single state machine. `AgentStatus = "starting|working|idle|input|error|stopped"` (`src/types.ts:15`), derived by `SquadManager.derive()` (`src/squad-manager.ts:3190`) but bypassed by **~15 direct `rec.dto.status =` assignments** scattered across `squad-manager.ts` (lines ~856–3142). A second disjoint vocabulary lives in `src/orchestrator-state.ts` (`Kind = verifying|verified|blocked|halted|landed|staged`). No transition guards; no transition history retained.
2. **Persistence & resume**: four independent mechanisms — roster snapshot (`src/dal/store.ts`, `reconnectLive()`/`adoptOrphanedAgents()`), detached agent-host supervisor (`src/agent-host.ts`), the **workflow engine's two-phase checkpoints** (`src/workflow/engine.ts`: entry+exit checkpoint per node; `EngineCheckpoint`/`WorkflowRunState` in `src/workflow/types.ts:157,182`; warm vs cold resume; `RESUME_ATTEMPT_CAP=3` poison guard), and the dispatch/orchestrator ledgers. **Gap**: non-workflow agents have no step-level checkpoint.
3. **Observability**: receipts (`src/receipts.ts`), spans (`src/spans.ts`), automation log (`src/automation-log.ts`), factory status (`src/factory-status.ts`), workflow journal (`WorkflowJournalEvent`, `src/workflow/types.ts:106`). **Gap**: no state-history timeline for plain agents — "why did it go to error" is transcript archaeology; no state diffs recorded.
4. **Sub-agents**: two disjoint models — `SubagentTracker` (`src/subagents.ts`, in-memory only, lost on restart) vs workflow parallel branches (real roster agents, `WorkflowFleet.runBranch`, `src/workflow-driver.ts:47`). Only lineage is `parentId`/`featureId` on the DTO/receipts. No unified parent/child run tree.
5. **Human-in-the-loop**: `pending[]` queue (`src/types.ts:32`); `"input"` status is *inferred from queue length*. `answerPending()` (`src/squad-manager.ts:2496`) → `respondUi()`. Workflow gates already do it right: `raiseGate` → answer persisted as `preferredLabel` in the checkpoint, folded forward via `GATE_FOLD_VAR`. Auto-supervisor (`src/supervisor.ts`) auto-answers non-risky pendings.
6. **Verify/land**: three cooperating retry systems that share no state model — verify-workflow overflow cascade (`src/workflow/verify-workflow.ts`, `maxVisits` + `noProgressRoute`), autoland (`src/autoland.ts` + `src/land.ts`, `autoLandFailCap`, `withRepoLandLock`), fleet orchestrator (`src/orchestrator.ts` + `src/resolver.ts` `routeFailure` + `orchestrator-state.ts` ledger). Gate sandbox in `src/gate-runner.ts`.

---

## Phase 2a — Comparator: concept extraction

| Concept | How Burr implements it | omp-squad today | Transferable? | Why / why not |
|---|---|---|---|---|
| Explicit transitions w/ guards | Declared ordered edges, first-true wins, no-match ⇒ loud halt | Three ad-hoc transition systems buried in imperative branches (resolver, verify cascade, orchestrator ledger) | **Yes** | The discipline transfers, not the matcher: a declared ordered table with explicit halt-on-no-match instead of silent default-casing. Burr sacrificed side-effecting conditionals for auditability. |
| Declared reads/writes (checkout/merge) | Actions declare state keys; framework isolates and merges | ~15 scattered direct `rec.dto.status` writes bypassing `derive()` | **Yes — top-tier** | Exactly the failure mode Burr's model prevents. Doesn't need the full ceremony — a single guarded write path + lint/CI check buys most of the auditability without the per-action declaration tax. |
| Immutable state + per-step diffs | Every step yields a diff, retained | Status is a live mutable scalar; no diffs anywhere | **Yes, selectively** | Apply at checkpoint/journal granularity where snapshots already exist; do NOT pay copy overhead on the hot status scalar. |
| (partition_key, app_id, sequence_id) addressing | One canonical run-address triple everywhere | Four separate keying schemes (roster, host socket, workflow run state, ledgers) | **Partially** | Value is unifying existing schemes behind one address, not adding a fifth. |
| **Fork-from-checkpoint** | New app_id seeded from any prior checkpoint; original untouched; tracker doubles as loader | **Zero analog.** `RESUME_ATTEMPT_CAP=3` abandons in place; verify cascade gives up rather than branching | **Yes — highest leverage** | Preserves the forensic trail of a failed run while retrying a different path from a known-good checkpoint. |
| Tracking-as-lifecycle-hooks | Official UI consumes the same public hook API users extend | 4+ purpose-built append logs (receipts/spans/automation/journal) evolved separately | **Yes, as principle** | Converge instrumentation onto one hook surface any future consumer (dashboard, exporter) gets for free. Define hook ordering explicitly — Burr didn't, and ordering bugs are the shape of bug this codebase has been burned by (OMPSQ-373..379). |
| Step-level state snapshots (Project→App→Step) | Every step records inputs + full state + timestamps | Workflow journal covers workflow runs; plain agents have nothing | **Partially present** | Generalize the journal to plain-agent lifecycle transitions. |
| Graph+source logged once per run | `post_application_create` snapshots the static graph | No topology snapshot at run start | **Yes, cheap** | Lets the UI render the *intended* graph rather than reconstructing it from log lines. |
| HITL as halt-condition (pause = durable state) | halt_before/halt_after + persist; no interrupt primitive | Workflow gates already correct (`preferredLabel` survives restart); plain agents infer "input" from queue length | **Yes, half-done** | Horizontal fix: bring plain agents up to what workflow gates already do. |
| spawning_parent lineage + hierarchical UI | Parent run-id + step-id pointer persisted with child; UI renders tree. Burr admits provisional | Two disjoint sub-agent models, one ephemeral | **Yes, scoped down** | Adopt only the convention (persisted parent-run + parent-step pointer, one schema for both models) — Burr has no mature mechanism to copy. |
| Deterministic child ids for fan-out resume | Child app_ids from parent context + task index ⇒ resume only incomplete branches | AbortController teardown handles live fan-out; nothing re-derivable after a crash | **Yes** | A restarted daemon could resume only unfinished branches instead of re-dispatching the whole join. |
| Persister status on every save | `"completed"\|"failed"` per checkpoint | Already present across ledgers/journal, just fragmented | **Redundant** | Consolidation opportunity only. |
| Serde registry | Per-field/per-type serializers | Ad-hoc JSON shaping ×4 | **Low priority** | No stated pain points at serialization correctness. |
| Sync/async dual API | Two parallel API families | N/A | **No** | Python problem; Bun is async-native. |

### Cross-reference highlights

- The workflow engine's **two-phase (entry+exit) checkpoint is stronger than Burr's single sequence-id marker** — omp-squad is ahead of Burr for workflow agents. The transfer target is plain agents, which have nothing.
- **Fork-from-checkpoint and deterministic fan-out child ids are the only two concepts with zero existing analog** — pure gaps.
- Workflow human gates already implement "pause = durable state" correctly; the `pending[]`-length inference for plain agents is an internal consistency fix, not a Burr import.

---

## Phase 2b — Strategist: ranked patterns for omp-squad

*(All are "borrow the pattern." Burr the dependency is Python, and its checkpoint model is weaker than our workflow engine's — there is no buy case anywhere in this brief.)*

### 1. Fork-from-checkpoint (rewind & retry under a new run id)

**Pattern**: A failed or capped-out run is never retried in place. Instead, mint a new run id whose initial state is copied from a chosen checkpoint of the prior run, with a persisted `forkedFrom: {runId, seq}` pointer. The original run's history is immutable and keeps its full forensic trail.
**Mechanism**: `WorkflowRunState` already persists `currentNode/visits/vars/outcome` per checkpoint. Add a fork constructor: given `(runId, checkpointSeq)`, produce a fresh `WorkflowRunState` with copied `vars`, reset `resumeAttempts`, new run id, `forkedFrom` lineage. Wire it into the two places that currently give up destructively: the `RESUME_ATTEMPT_CAP=3` poison path in `src/workflow/engine.ts` (escalate ⇒ offer/auto-create a fork instead of abandoning) and the verify cascade's `escalate` exhaustion in `src/workflow/verify-workflow.ts`. Surface "Fork from step N" in the webapp task detail next to the existing resume controls.
**Value for omp-squad**: today a poisoned resume or an exhausted fixup cascade throws away everything; the operator's only move is a cold re-dispatch that loses the checkpoint state and re-litigates work (the exact incident class behind the stale re-dispatch guards in PR #18). Forking converts dead ends into branch points with provenance.
**Where it applies**: `src/workflow/engine.ts`, `src/workflow/types.ts` (`WorkflowRunState` + a `forkedFrom` field), `src/squad-manager.ts` resume paths, webapp task detail.
**Build vs Buy**: build; ~1 concern.

### 2. Guarded single write-path for agent status, with recorded transition history

**Pattern**: One `transition(rec, to, reason, cause?)` function is the only code allowed to change an agent's status. It validates the move against a declared transition table (with the existing stickiness rules for `stopped`/`error`), appends `{from, to, reason, at}` to a persisted per-agent transition log, and re-derives dependent state. A lint/CI grep forbids `\.status\s*=` outside it.
**Mechanism**: Replace the ~15 direct `rec.dto.status =` assignments in `src/squad-manager.ts` with calls into the new function; keep `derive()` as the inference layer feeding it. Persist the transition log alongside the DTO in the roster snapshot (`src/dal/store.ts`) so it survives restart. This is Burr's checkout/merge insight at 5% of its ceremony.
**Value for omp-squad**: closes the "why did it go to error" archaeology gap at its root — every status change gets an attributed reason at write time instead of being reconstructed from transcript text. Also the precondition for pattern 3.
**Where it applies**: `src/squad-manager.ts` (the 15 write sites + `derive()`/`fail()`/`bindAgent()`/`onAgentEvent()`), `src/types.ts`, `src/dal/store.ts`.
**Build vs Buy**: build; ~1 concern, mostly mechanical.

### 3. State-transition timeline in the webapp

**Pattern**: The per-agent transition log (from pattern 2) rendered as a first-class timeline — every status change with its reason and cause, plus workflow journal events interleaved, so a run's lifecycle is one scrollable history rather than scattered across transcript/receipts/logs.
**Mechanism**: Expose the transition log via the existing agent DTO/API; add a "History" strip to the webapp agent detail (the synthesis dashboard's `lib/insights.ts` can also consume it — e.g. "3 error transitions in the last hour" as a hotspot signal). Burr's Step model (record state-at-execution) applied at transition granularity.
**Value for omp-squad**: the dashboard currently shows *what state* an agent is in; this shows *how it got there* — the single biggest debugging-experience gap the codebase map surfaced.
**Where it applies**: `webapp/` agent detail, `src/web/` API routes, `webapp/src/lib/insights.ts`.
**Build vs Buy**: build; ~1 concern, depends on 2.

### 4. Pause as durable state for plain agents

**Pattern**: "Waiting for input" is a persisted state with the question attached, not an inference from a mutable queue's length. On restart/adoption, an agent that was waiting is restored waiting, with its question intact.
**Mechanism**: Workflow gates already do this (`preferredLabel` in the checkpoint). Extend the roster persistence so `pending[]` (with request payloads) is snapshot-durable, and make the `input` status a real recorded transition (via pattern 2) with the pending request as its cause. Verify `adoptOrphanedAgents()` restores pendings.
**Value for omp-squad**: an agent's unanswered question surviving a daemon restart is exactly the "needs input" reliability the factory's supervise-by-exception model depends on; today it depends on incidental transcript+pending persistence.
**Where it applies**: `src/squad-manager.ts` (`onUi`/`onHostTool`/`answerPending`), `src/dal/store.ts`, `src/types.ts:PendingRequest`.
**Build vs Buy**: build; small.

### 5. Deterministic branch ids for fan-out resume

**Pattern**: Child run ids in a parallel fan-out are derived deterministically from `(parent run id, node id, branch index)`, so a restarted supervisor can enumerate which branches completed and resume only the unfinished ones instead of re-dispatching or abandoning the join.
**Mechanism**: `WorkflowEngine.runParallel` → `WorkflowFleet.runBranch` (`src/workflow-driver.ts:47`) currently spawns roster agents with fresh identities. Derive branch identity deterministically, record per-branch completion in the workflow checkpoint (branch outcomes are already rolled up), and on cold resume of a `parallel` node re-spawn only branches without a completed outcome.
**Value for omp-squad**: closes the crash-mid-fan-out hole — currently the AbortController teardown handles live cancellation but a daemon death mid-join has no branch-level resume. Directly the stale-re-dispatch incident shape (OMPSQ-373..379) applied to parallel nodes.
**Where it applies**: `src/workflow/engine.ts` (`runParallel`), `src/workflow-driver.ts` (`WorkflowFleet.runBranch`, `BranchSpec`), `src/workflow/types.ts` checkpoint schema.
**Build vs Buy**: build; ~1 concern.

### 6. One lineage schema for both sub-agent models

**Pattern**: Every child run — whether an omp-native subagent or a workflow branch agent — persists the same lineage pair: parent run id + parent step/node at spawn time. One schema, one queryable parent/child tree.
**Mechanism**: `SubagentTracker` (`src/subagents.ts`) keeps its RPC-frame-derived tree but flushes it into the persisted roster/receipts using the `parentId` (+ a new `parentStep`) fields workflow branches already write; the webapp renders one tree for both. Scoped down deliberately — Burr's own recursion story is provisional, so we copy the *convention*, not a mechanism.
**Value for omp-squad**: subagent trees currently evaporate on restart and the two models can't be shown in one view; a unified tree is what makes the fleet's actual topology inspectable.
**Where it applies**: `src/subagents.ts`, `src/receipts.ts` (`RunSeed.parentId/featureId`), `src/dal/store.ts`, webapp agent detail.
**Build vs Buy**: build; small-medium.

### 7. Journal the static graph once per run

**Pattern**: At workflow start, emit one journal record containing the full node/edge topology (ids, labels, transition conditions, budgets). Consumers render the intended graph and overlay live progress on it, instead of reconstructing shape from event lines.
**Mechanism**: `WorkflowDriver.emitJournal` (`src/workflow-driver.ts:262`) gains a `workflow.graph` event emitted before the first node; the webapp's existing plan-flow DAG renderer (`PlanFlowDiagram.tsx` lineage) gets a workflow-run variant.
**Value for omp-squad**: cheap, and makes the verify cascade's overflow routing (`codefix → fixup → escalate`) visible as a graph with visit budgets — currently only inferable from code.
**Where it applies**: `src/workflow-driver.ts`, `src/workflow/types.ts` (journal event union), webapp task detail.
**Build vs Buy**: build; trivial.

### Deliberately not ranked (noted for the future)

- **Unified retry/budget vocabulary** across engine `maxVisits`, `autoLandFailCap`, and `routeFailure` — the right long-term shape (one declared transition table, loud halt-on-no-match), but merging three live subsystems is a standalone initiative, not a pattern borrow. Revisit after 1–5 land.
- **Tracking-as-hooks convergence** of receipts/spans/automation-log/journal onto one hook surface — same standalone-initiative caveat; if attempted, define hook ordering explicitly (Burr didn't, and ordering races are this codebase's recurring bug shape).
- **Serde registry, canonical run-address triple** — real but marginal; fold into the above if they happen.

---

## Handoff

If chained into `/plan`: patterns 1–7 above are the goal, application points are pre-verified against the codebase (EXPLORE can be abbreviated), everything is build-not-buy, and this file is the durable record. Natural slicing: (2→3→4) as one "lifecycle truth" plan, (1, 5) as a "never lose work" plan, (6, 7) as an "inspectable topology" plan.
