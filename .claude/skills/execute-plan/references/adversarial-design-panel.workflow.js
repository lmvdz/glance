export const meta = {
  name: 'burr-plan-trio',
  description: 'Three parallel adversarial design teams for the Burr pattern-borrow slices',
  phases: [
    { title: 'Design', detail: 'sonnet designer drafts per slice' },
    { title: 'Red Team', detail: '2 adversarial critics per slice' },
    { title: 'Arbitrate', detail: 'final design brief per slice' },
    { title: 'Decompose', detail: 'concern-file drafts per slice' },
  ],
}

const BRIEF = 'plans/research-burr/BRIEF.md'

const LANDSCAPE = `TARGET: omp-squad (Bun/TypeScript autonomous agent factory; daemon manages fleet of coding agents in git worktrees, build->verify->land, Plane tickets, React webapp/).
Code-verified landscape (from ${BRIEF}, read it for full detail):
- AgentStatus = "starting|working|idle|input|error|stopped" (src/types.ts:15), derived by SquadManager.derive() (src/squad-manager.ts:3190) but bypassed by ~15 direct rec.dto.status= assignments across squad-manager.ts (lines ~856-3142). Separate Kind enum in src/orchestrator-state.ts. No transition guards/history.
- Persistence: roster snapshot src/dal/store.ts (FileStore state.json atomic rename / DbStore per-org), reconnectLive()+adoptOrphanedAgents() on boot; detached agent-host (src/agent-host.ts) survives daemon restarts; WorkflowEngine (src/workflow/engine.ts) two-phase entry+exit checkpoints, EngineCheckpoint/WorkflowRunState (src/workflow/types.ts:157,182) persist currentNode/visits/vars/outcome/preferredLabel/resumeAttempts, warm vs cold resume, RESUME_ATTEMPT_CAP=3 poison guard; dispatch ledger + orchestrator ledger.
- Observability: receipts (src/receipts.ts RunAccumulator->RunReceipt JSONL), spans (src/spans.ts), automation log (src/automation-log.ts), factory-status, workflow journal (WorkflowJournalEvent src/workflow/types.ts:106, emitted via WorkflowDriver.emitJournal src/workflow-driver.ts:262).
- Sub-agents: SubagentTracker (src/subagents.ts) in-memory tree from RPC frames, nothing persisted; workflow parallel branches = real roster agents via WorkflowFleet.runBranch (src/workflow-driver.ts:47) with max_parallel/join_policy/AbortController. Lineage = parentId/featureId on DTO/receipts only.
- HITL: pending[] queue (PendingRequest src/types.ts:32); "input" inferred from queue length; answerPending (src/squad-manager.ts:2496) -> respondUi. Workflow gates persist answers as preferredLabel in checkpoint (GATE_FOLD_VAR). Auto-supervisor src/supervisor.ts.
- Verify/land: verify-workflow cascade (src/workflow/verify-workflow.ts, maxVisits+noProgressRoute), autoland (src/autoland.ts+land.ts, autoLandFailCap, withRepoLandLock), fleet orchestrator (src/orchestrator.ts+resolver.ts routeFailure) + orchestrator-state ledger. Gate sandbox src/gate-runner.ts.
Webapp: webapp/ is the live React UI (agent controls + synthesis dashboard via webapp/src/lib/insights.ts).
Constraint: file-mode is the factory path; DbStore/db-mode exists but autonomy is file-mode-only today. Tests run with bun test (needs node_modules/.bin on PATH).`

const SLICES = [
  {
    name: 'lifecycle-truth',
    goal: 'Agent lifecycle state becomes trustworthy and explainable: (1) a guarded single write-path for AgentStatus with a declared transition table and persisted {from,to,reason,at} history replacing ~15 scattered rec.dto.status= writes; (2) a state-transition timeline surfaced in the webapp agent detail (and available to insights.ts); (3) pause-as-durable-state: pending[] requests persisted and restored across daemon restart/adoption so "input" is a real recorded state with the question attached.',
    hints: 'Key sites: src/squad-manager.ts (derive/fail/bindAgent/onAgentEvent + the 15 write sites), src/types.ts (AgentStatus, PendingRequest), src/dal/store.ts (PersistedAgent shape), webapp agent detail + webapp/src/lib/insights.ts, web API routes. Keep derive() as inference feeding the guarded transition fn. Enforce via lint/CI grep that .status= only happens inside the write-path. Watch: stickiness rules (stopped/error), DbStore parity, high write frequency (do NOT snapshot whole state per transition), adoptOrphanedAgents restoring pendings.',
  },
  {
    name: 'never-lose-work',
    goal: 'Failed runs become branch points instead of dead ends: (1) fork-from-checkpoint — mint a new workflow run id seeded from a chosen checkpoint of a prior run with persisted forkedFrom:{runId,seq} lineage, wired into the RESUME_ATTEMPT_CAP poison path and the verify-cascade escalate exhaustion, plus a webapp "fork from step N" control; (2) deterministic branch identities for parallel fan-out — child ids derived from (parent run id, node id, branch index), per-branch completion recorded in the checkpoint, cold resume of a parallel node re-spawns only branches without a completed outcome.',
    hints: 'Key sites: src/workflow/engine.ts (resume paths, RESUME_ATTEMPT_CAP, runParallel), src/workflow/types.ts (EngineCheckpoint/WorkflowRunState — add forkedFrom + branch outcomes), src/workflow-driver.ts (WorkflowFleet.runBranch, BranchSpec), src/workflow/verify-workflow.ts (escalate exhaustion), src/squad-manager.ts resume/workflow_done paths, webapp task detail. Watch: worktree/branch collisions when forking (new run must not reuse the failed run git branch blindly), dispatch-ledger interplay (avoid stale re-dispatch class OMPSQ-373..379), join_policy first_success semantics on partial resume, AbortController teardown vs durable branch records.',
  },
  {
    name: 'inspectable-topology',
    goal: 'The fleet actual run topology becomes one queryable, restart-surviving tree: (1) one lineage schema — every child run (omp-native subagent AND workflow branch agent) persists parent run id + parent step/node at spawn; SubagentTracker tree flushed to durable storage; webapp renders one unified parent/child tree; (2) journal the static workflow graph once per run (workflow.graph journal event with nodes/edges/conditions/budgets before first node) so the UI renders intended topology with live progress overlaid.',
    hints: 'Key sites: src/subagents.ts (SubagentTracker, explicitly in-memory today), src/receipts.ts (RunSeed.parentId/featureId), src/dal/store.ts, src/workflow-driver.ts (emitJournal), src/workflow/types.ts (journal event union), webapp task/agent detail (PlanFlowDiagram.tsx lineage exists for plan DAGs — a workflow-run variant). Watch: subagent RPC frame volume (persist tree snapshots on lifecycle boundaries, not every progress frame), id namespace collisions between omp subagent ids and roster agent ids, graph event schema versioning.',
  },
]

const ARBITER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approach', 'keyDecisions', 'risks', 'redTeamResolutions', 'openQuestions'],
  properties: {
    approach: { type: 'string', description: '2-4 paragraph final approach, staff-engineer level' },
    keyDecisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['decision', 'choice', 'alternatives', 'rationale'], properties: { decision: { type: 'string' }, choice: { type: 'string' }, alternatives: { type: 'string' }, rationale: { type: 'string' } } } },
    risks: { type: 'array', items: { type: 'string' } },
    redTeamResolutions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['concern', 'severity', 'resolution'], properties: { concern: { type: 'string' }, severity: { enum: ['critical', 'significant', 'minor'] }, resolution: { type: 'string' } } } },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'MUST be empty unless truly undecidable without the user; resolve everything you can' },
  },
}

const DECOMP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'batches', 'notes', 'concerns'],
  properties: {
    outcome: { type: 'array', items: { type: 'string' }, description: 'bullet list: what the operator gets when this ships' },
    batches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['batch', 'concerns', 'why'], properties: { batch: { type: 'integer' }, concerns: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } } } },
    notes: { type: 'array', items: { type: 'string' }, description: 'decisions a human needs before starting; include cross-plan file overlaps' },
    concerns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'title', 'priority', 'complexity', 'touches', 'goal', 'approach', 'verify', 'blockedBy', 'verifyBlocker'], properties: {
      file: { type: 'string', description: 'NN-kebab-name.md' },
      title: { type: 'string' },
      priority: { enum: ['p0', 'p1', 'p2'] },
      complexity: { enum: ['mechanical', 'architectural', 'research'] },
      touches: { type: 'array', items: { type: 'string' } },
      goal: { type: 'string' },
      approach: { type: 'string', description: 'implementation detail incl. code sketches for non-obvious parts; markdown' },
      verify: { type: 'string', description: 'concrete commands/steps to confirm it works' },
      blockedBy: { type: 'array', items: { type: 'string' }, description: 'concern files this depends on, [] if none' },
      verifyBlocker: { type: 'string', description: '30s check per blocker that it is real at execution time; empty if no blockers' },
    } } },
  },
}

const results = await pipeline(
  SLICES,
  // Round 1: Designer (sonnet)
  (s) => agent(
    `You are the DESIGNER for plan slice "${s.name}" of the omp-squad Burr pattern-borrow initiative.\n\nGOAL: ${s.goal}\n\nHINTS (pre-verified): ${s.hints}\n\n${LANDSCAPE}\n\nFirst READ ${BRIEF} (strategist section) and then READ the actual key source files named in the hints (use Read/Grep; verify line numbers and current shapes yourself — the daemon code may have drifted). Then produce a DRAFT DESIGN: 2-3 candidate approaches with tradeoffs, key decisions, risks, and a clear recommendation. Concrete: name real functions/types you verified, describe data shapes (fields, where persisted), migration path for existing persisted state, and how it behaves in file-mode AND DbStore mode. Your final message is the draft design document (markdown).`,
    { label: `design:${s.name}`, phase: 'Design', model: 'sonnet' }
  ).then(draft => ({ draft })),
  // Round 2: Red Team x2 (fable, parallel)
  (r, s) => parallel([1, 2].map(n => () => agent(
    `You are RED TEAMER #${n}, adversarially reviewing a design for omp-squad slice "${s.name}".\n\nGOAL: ${s.goal}\n\n${LANDSCAPE}\n\nDRAFT DESIGN:\n${r.draft}\n\nYour job is to ATTACK this design. ${n === 1 ? 'Focus especially on: concurrency, partial failure, daemon-restart/crash windows, persistence corruption, and interactions with existing subsystems (adoption, autoland, orchestrator, dispatch ledger).' : 'Focus especially on: simpler alternatives the designer missed, wrong/unverified assumptions about the code, migration/compat hazards (existing state.json/checkpoints in the wild, global daemon install), webapp/API contract gaps, and scope creep that should be cut.'} You may Read source files to verify claims. For each issue: SEVERITY (critical|significant|minor), EVIDENCE (why real, cite file:line where possible), SUGGESTION. Be specific — "might not scale" is useless. Final message = your critique list.`,
    { label: `red${n}:${s.name}`, phase: 'Red Team' }
  ))).then(crits => ({ ...r, critiques: crits.filter(Boolean) })),
  // Round 3: Arbiter (fable)
  (r, s) => agent(
    `You are the ARBITER for omp-squad plan slice "${s.name}".\n\nGOAL: ${s.goal}\n\n${LANDSCAPE}\n\nDRAFT DESIGN:\n${r.draft}\n\nRED TEAM CRITIQUE 1:\n${r.critiques[0] || '(missing)'}\n\nRED TEAM CRITIQUE 2:\n${r.critiques[1] || '(missing)'}\n\nProduce the FINAL design brief. Critical issues MUST be addressed; significant ones addressed or explicitly accepted with mitigation; where red teamers disagree, weigh evidence — don't average. You may Read source to settle factual disputes. Resolve every open question you possibly can (this is a headless run); leave openQuestions non-empty only for genuinely user-only decisions.`,
    { label: `arbiter:${s.name}`, phase: 'Arbitrate', schema: ARBITER_SCHEMA }
  ).then(final => ({ ...r, final })),
  // Round 4: Decomposer (sonnet)
  (r, s) => agent(
    `You are the DECOMPOSER for omp-squad plan slice "${s.name}". Turn the final design into executable concern files.\n\nGOAL: ${s.goal}\n\n${LANDSCAPE}\n\nFINAL DESIGN (arbiter-approved):\napproach: ${r.final.approach}\nkeyDecisions: ${JSON.stringify(r.final.keyDecisions)}\nrisks: ${JSON.stringify(r.final.risks)}\nredTeamResolutions: ${JSON.stringify(r.final.redTeamResolutions)}\n\nRules: 2-5 concerns, each independently landable where possible; number files 01-,02-,...; every blockedBy needs a verifyBlocker (a 30s concrete check); TOUCHES must be real repo-relative paths (Read/Grep to verify — do not guess); if two concerns share a file, either merge them or make the dependency explicit; Approach sections carry the implementation detail (incl. code sketches for non-obvious parts) since DESIGN.md stays high-level; Verify sections give concrete commands (bun test needs node_modules/.bin on PATH). Note cross-PLAN overlaps in notes: lifecycle-truth touches src/squad-manager.ts+src/types.ts+src/dal/store.ts; never-lose-work touches src/workflow/*+workflow-driver.ts; inspectable-topology touches src/subagents.ts+receipts.ts+dal/store.ts+workflow-driver.ts+workflow/types.ts.`,
    { label: `decompose:${s.name}`, phase: 'Decompose', model: 'sonnet', schema: DECOMP_SCHEMA }
  ).then(decomp => ({ slice: s.name, draft: r.draft, critiques: r.critiques, final: r.final, decomp }))
)

return results.filter(Boolean)