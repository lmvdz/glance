# Autonomous AI Fleet System — meta-plan

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural

## Outcome

The fleet gains the trust layer that lets it run a meta-goal unattended without amplifying its own errors: an independent validator with veto, a replayable end-to-end audit trail, confidence-gated human-in-the-loop, a learning orchestrator, and a convergence loop that iterates `plan → implement → validate → ratchet → escalate` against a fixed definition of done. Each epic below is a **branch** that decomposes into its own sub-plan until every leaf is a Sonnet-ready unit.

## Work

| Concern | Why it exists | Complexity | Touches (attach points) |
|---|---|---|---|
| 01 Resident planner | Planning is 100% human-triggered today; the loop needs a standing decomposer | architectural (branch) | `src/plan-sync.ts` (inverse), `SquadManager.start()`, `src/features.ts`, `webapp/src/lib/planGraph.ts`, `src/intake.ts` |
| 02 Execution roles | The coder grades its own self-authored test — split the roles | architectural (branch) | `src/workflow/verify-workflow.ts` (`buildTddVerifyWorkflow`, dormant), `src/intake.ts`, `src/types.ts` (`AgentKind`), `src/observer.ts`, `src/squad-manager.ts` (`createWithId`) |
| 03 Independent validator | **Critical path.** No independent semantic judge exists | architectural (branch) | `src/proof.ts` (`proofGate`), `src/workflow/verify-workflow.ts`, `src/server.ts` (`governancePayload`), audit/land/dispatch ledgers, `acceptanceCriteria` field |
| 04 Replayable traceability | Trace is off-by-default + 90% sampled; 3 disconnected streams | architectural (branch) | `src/trace-exporter.ts`, `src/spans.ts` (`traceSampleRatio`, `buildTrace`), `src/receipts.ts`, `src/audit.ts`, `src/automation-log.ts`, `src/omp-graph/*`, `webapp/src/omp-graph/*` |
| 05 HITL safeguards | No confidence scoring; propose-only exists but has no trigger | architectural (branch) | `src/autonomy.ts` (`maxEffectiveMode`), `src/digest.ts` (run-end), `webapp/src/lib/insights.ts`, `src/squad-manager.ts` (`SQUAD_HOST_TOOLS`, `PendingRequest`), `src/types.ts` |
| 06 Learning orchestrator | `agentic-learning-loop` is designed, unbuilt; model routing is static | architectural (branch) | `plans/agentic-learning-loop/*` (execute), `src/metrics.ts` (new), `src/reflection.ts` (new), `src/land-ledger.ts`, `src/intake.ts`, `src/workflow/stylesheet.ts` |
| 07 Convergence loop | The capstone — the never-ending, cache-warm, self-verifying loop | architectural (branch) | Stop-hook (`.claude/settings`), verified-state oracle, `src/orchestrator.ts`, budget + arming gate |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| A | 03, 04 | Trust foundation. Independent + both mostly independent of each other. Build the oracle and the audit trail first. |
| B | 02, 05 | 05 consumes 03's validator-agreement signal for confidence; 02's observing-agent pairs with the validator. |
| C | 01, 06 | 06 consumes 05's confidence for threshold tuning; 01 feeds the loop. Both attach at `SquadManager.start()`. |
| D | 07 | Capstone. Cannot safely run until 3 (validator) and 5 (confidence exit) exist. |

Estimated 4 batches at the epic level; each epic expands into its own batched sub-plan.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 Resident planner | — | `grep -n "syncPlanStatuses" src/plan-sync.ts` (inverse target exists) |
| 02 Execution roles | — | `grep -n "buildTddVerifyWorkflow" src/workflow/verify-workflow.ts` (dormant role exists) |
| 03 Independent validator | — | `grep -n "acceptanceCriteria" webapp/src/data.ts` (criteria field exists to score against) |
| 04 Replayable traceability | — | `grep -n "traceSampleRatio" src/spans.ts` (returns 0.1 default) |
| 05 HITL safeguards | — (03 enriches, does not block) | confidence scorer is pure (verificationState + filesTouched); validator agreement is an *optional* input, so 05 ships before 03 — decoupling found at decomposition |
| 06 Learning orchestrator | 05 | confidence score exists on the run record (Epic 5 leaf shipped) |
| 07 Convergence loop | 01, 02, 03, 05, 06 | validator veto + confidence propose-only both live; `grep` for the confidence cap in `src/autonomy.ts` |

**Grounded-ordering corrections from recursive decomposition** (the sub-plans are authoritative on per-leaf deps): Epic 1's verified-state oracle already exists (`done-proof.ts` `hasProof`) so it has no 3/7 dependency; Epic 5's confidence is computable without the validator so 05 no longer hard-blocks on 03 (03 only enriches it); Epic 3's veto attaches at `landBranch` (all lands, incl. forced) not a verify-workflow node; Epic 2 uses `ExecutionRole` (name clash with RBAC `Role`) and does not extend `AgentKind`.

## Notes

- **WIP snapshot at creation:** proceeded over 4 real open plans (`console-agent-tooling` 6, `agentic-learning-loop` 5, `factory-control-plane` 3, `change-driven-loops` 1) on explicit operator directive to build this meta-plan. `agentic-learning-loop` and `factory-control-plane` are folded in as prior-art dependencies (Epics 6/3), not duplicated.
- Every epic here is a **branch** (`SUBPLAN:` pointer inside each concern file). The recursion contract in `DESIGN.md` defines when a child concern becomes a Sonnet-ready leaf.
- Not yet filed to Plane — file the leaf concerns via `/plan-to-plane` after recursive decomposition, so `/sync-plans` can track the real executable units rather than the branch nodes.
