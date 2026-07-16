export type AgentStatus = "starting" | "working" | "idle" | "input" | "error" | "stopped";
export type FeatureStage = "planned" | "issues-created" | "in-progress" | "review" | "diverged" | "landed" | "done";
export type WorktreeProofState = "none" | "failed" | "stale" | "fresh";
/** Mirrors backend `FeatureCategory` (src/types.ts) — the operator override on `FeatureDTO.category`.
 *  Absent ⇒ the client derives a bucket from title+planDir (task-model.ts), falling back to 'other'. */
export type FeatureCategoryDTO = "frontend" | "devops" | "backend" | "mcp" | "database" | "other";


export interface PendingRequest {
  id: string;
  source: "ui" | "tool";
  kind: string;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  createdAt: number;
  gateClass?: boolean;
}

/** Mirrors backend `AgentReport` (src/types.ts) — a non-blocking "I'm unsure, here's a proposal"
 *  note. NOT a `PendingRequest`: it never blocks the agent or flips status to "input" (Epic 5 D2). */
export interface AgentReport {
  id: string;
  summary: string;
  proposal?: string;
  confidence?: number;
  createdAt: number;
}

/** Mirrors backend `AttentionEvent` (src/types.ts) — a harness-agnostic, non-blocking "look at this"
 *  signal (operator `notify`, an omp `squad_attention` tool call, a raw harness notify RPC, or a
 *  `glance here` turn patch HELD instead of auto-applied to the operator's real checkout —
 *  "boundary-sync", daily-onramp 03; "held" rows carry one-click Apply/Discard). */
export interface AttentionEvent {
  id: string;
  summary: string;
  detail?: string;
  source: "notify" | "tool" | "harness" | "boundary-sync";
  /** boundary-sync rows only: "held" = durable patch(es) waiting (Apply/Discard resolve it);
   *  "uncapturable" = NOTHING is held (the turn's delta couldn't be captured) — offering Apply
   *  there would be false reassurance, so those rows get View instead. */
  sync?: "held" | "uncapturable";
  createdAt: number;
}

/** Mirrors backend `TransitionEntry` (src/types.ts). One recorded (or denied) `{from,to,reason,at}`
 *  lifecycle transition. */
export interface TransitionEntry {
  agentId: string;
  from: AgentStatus;
  to: AgentStatus;
  reason: string; // widen from the backend's literal union — the webapp only displays it, never branches on exhaustive cases
  at: number;
  cause?: { error?: string; priorId?: string; [k: string]: unknown };
  denied?: true;
}

export interface IssueRef {
  id: string;
  identifier?: string;
  name: string;
  state?: string;
  priority?: "urgent" | "high" | "medium" | "low" | "none" | string;
  url?: string;
  projectId?: string;
  blockedBy?: string[];
  noAutoDispatch?: boolean;
}

export interface ProjectDTO {
  id: string;
  name: string;
  repo: string;
  agentCount: number;
  statusCounts: Partial<Record<AgentStatus, number>>;
  pendingCount: number;
  lastActivity: number;
  /** Persisted features in this repo — work that outlives the agent that was doing it. */
  featureCount: number;
  /** The operator explicitly registered this repo (vs it merely having agents/features today). */
  registered: boolean;
}

export interface FeatureCriterionDTO {
  id: string;
  text: string;
  completed: boolean;
  source?: "plan" | "ticket" | "workflow" | "manual";
}

/** Mirrors backend `LensVerdict` (src/types.ts) — one perspective-diversified advisory lens verdict.
 *  `lens` mirrors backend `LensId` (src/lens-select.ts), currently the single literal "regression". */
export interface LensVerdictDTO {
  lens: "regression";
  disposition: "accept" | "object";
  severity: "low" | "high";
  claim: string;
}

/** Mirrors backend `ValidationRecord` (src/types.ts) — Epic 3's independent-validator verdict for an
 *  agent's most recent land attempt.
 *
 *  This is a HAND-MAINTAINED mirror with no compiler edge to the backend type — a field added to (or
 *  renamed/retyped on) `ValidationRecord` does not fail `tsc` here on its own. `tests/dto-conformance.test-d.ts`
 *  (wired into the root tsconfig's `include`) is that edge: it asserts every key declared here exists on
 *  `ValidationRecord` with an IDENTICAL type, so this file drifting out of sync fails `bun run check`,
 *  not just a runtime read nobody happened to exercise. It is EQUALITY minus an explicit, named omit list
 *  (`OmittedFromValidationRecordDto`, empty today), not a one-directional subset — a subset check passes
 *  trivially the moment a new backend field is simply never mirrored, which is exactly how `gateLogPaths`
 *  went unmirrored for months undetected. A new backend field must now either be mirrored here or named
 *  in the omit list on purpose; leaving it out of both fails the build. */
export interface ValidationRecordDTO {
  verdict: "pass" | "veto" | "abstain" | "skipped" | "inconclusive";
  agreement: number;
  confidence: number;
  perCriterion: { id: string; satisfied: boolean; note?: string }[];
  rationale: string;
  model?: string;
  /** Cross-lineage review: vendor lineage of author vs judge; `sameLineage` true = self-graded
   *  (weaker signal). Mirrors backend ValidationRecord (src/model-lineage.ts). */
  authorLineage?: "anthropic" | "openai" | "google" | "xai" | "unknown";
  reviewerLineage?: "anthropic" | "openai" | "google" | "xai" | "unknown";
  sameLineage?: boolean;
  /** Perspective-diversified review (plans/perspective-diversified-review/): advisory out-of-criteria
   *  lens verdicts that ran ALONGSIDE the authoritative criteria judge. Never changes `verdict`. */
  lensAdvisory?: LensVerdictDTO[];
  /** The one-shot re-check of a high-severity lens objection. `confirmed:true` maxes the confidence
   *  penalty; it still never vetoes. */
  lensVerify?: { lens: "regression"; claim: string; confirmed: boolean };
  /** Lossless gate-log offload (plans/eap-borrows/ concern 03): pointer path(s) under
   *  `<stateDir>/gate-logs/<agentId>/` to the FULL diff/proof text when either exceeded the judge's
   *  excerpt budget. Absent ⇒ nothing was oversized (the common case). Type hygiene only — not rendered
   *  anywhere in the webapp yet. */
  gateLogPaths?: string[];
  ranAt: number;
}

export interface FeatureDecisionDTO {
  id: string;
  text: string;
  source?: "plan" | "human" | "agent";
  createdAt?: number;
}

export interface FeatureRelationshipDTO {
  id: string;
  targetId: string;
  targetTitle: string;
  type?: "issue" | "blocks" | "depends-on" | "related";
  url?: string;
}

export interface FeatureContextBundleDTO {
  spec: string;
  criteria: string;
  prerequisites: string;
  decisions: string;
  downstream: string;
}

export type LandReadinessDTO = "clean" | "uncommitted" | "ahead" | "diverged" | "merged" | "no-branch";
export interface WorktreeProofSummaryDTO { state: "none" | "failed" | "stale" | "fresh"; ranAt?: number; artifacts: number }
export interface FeatureWorktreeStatusDTO { agentId?: string; agentName?: string; branch?: string; worktree: string; changedFiles: number; ahead: number; behind: number; readiness: LandReadinessDTO; proof?: WorktreeProofSummaryDTO }
export interface FeatureProofAggregateDTO { fresh: number; failed: number; stale: number; none: number; latestRanAt?: number; artifacts: number }
export type FeatureReadinessStateDTO = "no-candidate" | "needs-proof" | "proof-failed" | "proof-stale" | "blocked-input" | "diverged" | "uncommitted" | "ready" | "landed" | "done";
export interface FeatureReadinessDTO { ready: boolean; state: FeatureReadinessStateDTO; blockers: string[]; nextAction: string }
export type PlanRevisionCandidateStateDTO = "candidate" | "accepted" | "rejected" | "superseded";
export interface PlanRevisionCandidateDTO { id: string; featureId: string; repo: string; planPath: string; producerAgentId?: string; runId?: string; traceId?: string; summary: string; diffRef?: string; state: PlanRevisionCandidateStateDTO; reason?: string; reviewer?: string; createdAt: number; updatedAt: number }

/** Mirrors src/done-proof.ts's DoneProof — the ONE artifact that authorizes a Done write or PR-mode
 *  reachability claim. Surfaced read-only in the task-pipeline artifacts rail (GET
 *  /api/features/:id/done-proof); purely advisory there, never a gate. */
export interface DoneProofDTO {
  branch: string;
  repo: string;
  issueId?: string;
  issueIdentifier?: string;
  mode: "local" | "pr";
  method?: "merge" | "squash" | "rebase";
  commit: string;
  mergeCommit?: string;
  baseRef: string;
  verified: "green" | "red-baseline" | "unverified";
  detail: string;
  provenAt: number;
  prNumber?: number;
  prUrl?: string;
}

export interface PlanAnnotationTargetDTO {
  planPath: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: string;
  /** Anchors the annotation to a specific rendered plan block (data-block-id). Additive/optional. */
  blockId?: string;
  /** Anchors the annotation to a markdown H2 section — the design-review screen's anchor. */
  heading?: string;
}

export interface ArtifactCommentDTO {
  id: string;
  repo: string;
  subject: string;
  body: string;
  author: string;
  urgent?: boolean;
  createdAt: number;
  kind?: "comment" | "plan-annotation";
  annotation?: PlanAnnotationTargetDTO;
  resolvedAt?: number;
}


export interface FeatureDTO {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  repo: string;
  stage: FeatureStage;
  planDir?: string;
  agentIds: string[];
  /** Human assignees — user identity strings (`db:<userId>` in DB mode, the operator identity in
   *  file mode). The substrate for plan voting (a later vote is majority-of-all-assignees). Always
   *  present (seeded on first persist; legacy features default to `[operator]`). */
  assignees: string[];
  worktrees: FeatureWorktreeStatusDTO[];
  unlandedFiles: number;
  divergent: boolean;
  blocked: boolean;
  statusCounts: Partial<Record<AgentStatus, number>>;
  issueIdentifiers?: string[];
  persisted?: boolean;
  /** Manual category pin (operator override) — see `FeatureCategoryDTO`'s doc comment. */
  category?: FeatureCategoryDTO;
  workflowStage?: string;
  workflowProgress?: { done: number; total: number };
  workflowProof?: WorktreeProofSummaryDTO;
  description?: string;
  acceptanceCriteria?: FeatureCriterionDTO[];
  decisions?: FeatureDecisionDTO[];
  relationships?: FeatureRelationshipDTO[];
  readiness: FeatureReadinessDTO;
  contextBundle?: FeatureContextBundleDTO;
  proof?: FeatureProofAggregateDTO;
  planRevisionCandidates?: PlanRevisionCandidateDTO[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoTaskDTO {
  content: string;
  status: TodoStatus;
}

export interface TodoPhaseDTO {
  name: string;
  tasks: TodoTaskDTO[];
}

export interface ReceiptRollupDTO {
  toolCalls: number;
  costUsd?: number;
  durationMs?: number;
  endedAt?: number;
  tokens?: number;
}

export interface AgentSessionSummaryDTO {
  id?: string;
  name?: string;
  file?: string;
  thinkingLevel?: string;
  messageCount?: number;
  queuedMessageCount?: number;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
}

export type AutonomyMode = "observe" | "assist" | "autodrive";
export type VerificationState = "unknown" | "none" | "failed" | "stale" | "fresh";
export type AgentAction = "prompt" | "answer" | "interrupt" | "verify" | "land" | "set-mode";

/** Mirrors src/types.ts's AgentKind — which runtime backs this agent. */
export type AgentKind = "omp-operator" | "flue-service" | "workflow";

/** Mirrors src/types.ts's ExecutionRole — role specialization, orthogonal to kind. */
export type ExecutionRole = "tester" | "observer";

/** One node in a journaled workflow graph snapshot (mirrors src/workflow/types.ts's WorkflowGraphNode). */
export interface WorkflowGraphNodeDTO {
  id: string;
  kind: string;
  label?: string;
  maxVisits?: number;
  overflow?: string;
  goalGate?: boolean;
  /** On failure with no matching edge, route here — rendered as a dashed failure edge. */
  retryTarget?: string;
}

/** One edge in a journaled workflow graph snapshot (mirrors WorkflowGraphEdge). */
export interface WorkflowGraphEdgeDTO {
  from: string;
  to: string;
  label?: string;
  condition?: string;
}

/** Static topology snapshot of a workflow's DOT graph, journaled once per run (concern 03) so the
 *  UI can render intended structure with live progress overlaid. version:1 is additive/forward-compat. */
export interface WorkflowGraphSnapshotDTO {
  version: 1;
  name: string;
  nodes: WorkflowGraphNodeDTO[];
  edges: WorkflowGraphEdgeDTO[];
  start: string;
  exit: string;
  maxNodeVisits?: number;
}

/** Live progress over a workflowGraph — mirrors the fields of src/workflow/types.ts's WorkflowRunState
 *  the webapp actually reads. Widened/partial on purpose, matching the existing workflowState doc
 *  convention: the webapp never branches on exhaustive workflow-state cases. `runId`/`terminal` are
 *  kept from the pre-existing narrower shape (still riding the same wire payload, still what the Fork
 *  button's `forkAvailable` gate is documented against). */
export interface WorkflowRunStateDTO {
  currentNode: string;
  visits: Record<string, number>;
  vars: Record<string, string>;
  outcome?: "succeeded" | "failed";
  preferredLabel?: string;
  rollup: { label: string; status: "in_progress" | "completed" }[];
  runId?: string;
  terminal?: { reason: string; at?: number; forkPoint?: { runId?: string; seq: number }; supersededBy?: string };
}

/** One node in an agent's subagent tree (task-spawned children) — mirrors src/subagents.ts's
 *  SubagentNode. task/description are truncated + redacted server-side before they ever reach here. */
export interface SubagentNodeDTO {
  id: string;
  agent: string;
  description?: string;
  status: string;
  task?: string;
  lastUpdate: number;
  index: number;
}

/** Aggregate rollup across every receipt under a trace — mirrors src/spans.ts's TraceRollup.
 *  Never sampled (unlike the span waterfall below), so this is always the primary view. */
export interface TraceRollupDTO {
  runs: number;
  toolCalls: number;
  costUsd: number;
  tokens: number;
  durationMs: number;
  errors: number;
}

export type TraceSpanKindDTO = 'run' | 'node' | 'tool' | 'subagent' | 'verify' | 'spawn' | 'validate' | 'land' | 'resolve';
export type TraceSpanStatusDTO = 'ok' | 'error' | 'running';

/** One span in the trace tree — mirrors src/spans.ts's TraceNode. Fine spans are tail-sampled, so a
 *  node with no children isn't necessarily a leaf run; see TraceResponseDTO.partial. */
export interface TraceNodeDTO {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: TraceSpanKindDTO;
  startedAt: number;
  endedAt?: number;
  status: TraceSpanStatusDTO;
  attrs?: Record<string, string>;
  children: TraceNodeDTO[];
  rollup: TraceRollupDTO;
}

/** One receipt contributing to a trace — the fields the drill-in panel's run list needs, not the
 *  full server-side RunReceipt (which also carries filesTouched/toolTally/etc.). */
export interface TraceReceiptSummaryDTO {
  agentId: string;
  name: string;
  status: string;
  runId: string;
  costUsd?: number;
  durationMs?: number;
  toolCalls: number;
  endedAt?: number;
}

/** Mirrors src/spans.ts's TraceResponse — the `/api/trace/:id` payload. */
export interface TraceResponseDTO {
  traceId: string;
  root: TraceNodeDTO;
  rollup: TraceRollupDTO;
  receipts: TraceReceiptSummaryDTO[];
  /** True when at least one receipt has NO spans at all (legacy/pre-sampling-fix rows) — the decision
   *  spine is genuinely missing. A finalized run always carries its structural spine, so this is false
   *  for normal runs regardless of tool-level sampling; see `sampled` for that softer signal. */
  partial: boolean;
  /** True when at least one contributing receipt had its tool-level spans tail-sampled out. Renders as
   *  a muted "tool detail sampled" chip, distinct from the alarming `partial` badge. */
  sampled?: boolean;
}

/** Mirrors backend `HarnessDimension` (src/harness-scorecard.ts). */
export type HarnessDimension = 'instructions' | 'tools' | 'environment' | 'state' | 'feedback';

/** Mirrors backend `HarnessScorecard` (src/harness-scorecard.ts) — a pre-dispatch, advisory-only
 *  static score of a unit's harness bundle across the five subsystems the learn-harness-engineering
 *  curriculum names. Computed once at spawn and stamped onto the DTO; never persisted, never gates
 *  anything. Absent on agents spawned before this shipped, or restored/adopted without a fresh spawn. */
export interface HarnessScorecardDTO {
  score: number;
  dimensions: Record<HarnessDimension, boolean>;
  redFlags: string[];
  at: number;
}

export interface AgentDTO {
  id: string;
  name: string;
  status: AgentStatus;
  /** Which runtime backs this agent. */
  kind?: AgentKind;
  /** Specialization of this unit ("tester" writes the test first, "observer" reproduces a
   *  regression), orthogonal to `kind`. Absent = general coder (today's default). */
  executionRole?: ExecutionRole;
  /** Parent agent id, when this agent is a spawned fan-out branch (workflow) or task subagent. */
  parentId?: string;
  /** The node in the PARENT's workflow graph this branch executes — structural lineage, distinct
   *  from `name` (mutable, identical across parallel siblings of one node). */
  parentNodeId?: string;
  /** Distinguishes same-node siblings (parallel fan-out) and cold-resume re-spawns of the same node. */
  branchIndex?: number;
  /** Persisted subagent tree snapshot (task-spawned children). */
  subagents?: SubagentNodeDTO[];
  /** Static workflow graph topology, captured once per run (concern 03's workflow.graph journal event). */
  workflowGraph?: WorkflowGraphSnapshotDTO;
  workflow?: { path?: string; verify?: { command: string } };
  repo: string;
  worktree: string;
  branch?: string;
  model?: string;
  startedAt?: number;
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  receipt?: ReceiptRollupDTO;
  /** The live/last run's trace id — mirrors src/types.ts's AgentDTO.traceId. Same id-space `GET
   *  /api/trace/:id` expects (`feat:<featureId>` or `run:<agentId>:<receiptRunId>`); absent until a run
   *  has actually started. `traceIdForAgent` (trace.ts) prefers `featureId` when present, else this. */
  traceId?: string;
  session?: AgentSessionSummaryDTO;
  profileId?: string;
  activity?: string;
  todo?: { done: number; total: number; active?: string };
  todoPhases?: TodoPhaseDTO[];
  pending: PendingRequest[];
  /** Non-blocking proposals raised via `squad_report`, or auto-emitted on a low-confidence run
   *  (Epic 5 D2). Surfaced as a warn "Needs you" row — never affects `status`/`effectiveMode`. */
  reports?: AgentReport[];
  /** Harness-agnostic attention lane (v2 glance-notify) — append-only, live/run-scoped, mirrors
   *  `reports`. Surfaced as a warn "Needs you" row alongside reports, never affects `status`. */
  attentionEvents?: AttentionEvent[];
  transitions?: TransitionEntry[];
  errorTransitions1h?: number;
  lastActivity: number;
  messageCount?: number;
  error?: string;
  issue?: IssueRef;
  featureId?: string;
  autonomyMode: AutonomyMode;
  effectiveMode: AutonomyMode;
  verificationState: VerificationState;
  proof?: { commit?: string; command?: string; ranAt?: number; fingerprint?: string };
  /** Epic 3 independent-validator verdict for this agent's most recent land attempt. */
  validation?: ValidationRecordDTO;
  blockedReason?: string;
  availableActions: AgentAction[];
  /** Run-end self-confidence 0..1; absent until a run has finished. Below the daemon's confidence
   *  floor caps `effectiveMode` to `assist` (propose-only). */
  confidence?: number;
  landReady?: boolean;
  /** PR-mode landing metadata, set at push (draft/open) and merge (merged) time. Absent in local mode. */
  prUrl?: string;
  prNumber?: number;
  prState?: 'draft' | 'open' | 'merged' | 'closed';
  /** Derived from the daemon's persisted `workflowState.terminal` marker (present and not yet
   *  superseded by a fork) — survives a daemon restart. Absent (not just false) on an old daemon
   *  that never sets the field, which is exactly the gate the Fork button uses: an old daemon never
   *  shows it instead of showing it disabled or 404ing. */
  forkAvailable?: boolean;
  /** Live progress (currentNode/rollup/etc.) over `workflowGraph`'s static topology, plus the
   *  terminal/runId subset the Fork button's `forkAvailable` gate is documented against. */
  workflowState?: WorkflowRunStateDTO;
  /** Pre-dispatch harness scorecard (advisory shadow) — see `HarnessScorecardDTO`. */
  harnessScorecard?: HarnessScorecardDTO;
}

export interface TranscriptTool {
  callId: string;
  name: string;
  args?: unknown;
  argsText?: string;
  partial?: unknown;
  partialText?: string;
  result?: unknown;
  resultText?: string;
  isError?: boolean;
  durationMs?: number;
}

export type TranscriptFormat = "markdown" | "command" | "stage" | "plain";

export interface TranscriptPending {
  requestId: string;
  action: "created" | "answered" | "cancelled";
}

export interface TranscriptEntry {
  id?: string;
  seq?: number;
  kind: "user" | "assistant" | "thinking" | "tool" | "system";
  text: string;
  ts: number;
  clientTurnId?: string;
  /**
   * The user's bare typed text, when it differs from `text` (the full context-augmented
   * message the agent actually received). UI renders this when present; `text` stays the
   * durable audit/debug record.
   */
  displayText?: string;
  status?: "running" | "ok" | "error" | "cancelled";
  tool?: TranscriptTool;
  format?: TranscriptFormat;
  pending?: TranscriptPending;
}

export interface CommandInfo {
  name: string;
  description?: string;
  args?: string;
}


export interface PublicCapabilityProfileDTO {
  id?: string;
  name: string;
  description?: string;
  model?: string;
}

export interface PublicCapabilityCatalogDTO {
  id: string;
  source: string;
  title: string;
  description: string;
  framework: "omp" | "workflow" | "flue" | "external";
  version: string;
  slug: string;
  checksum: string;
  requiredEnv: string[];
  profiles: PublicCapabilityProfileDTO[];
  tools: { name: string; description?: string }[];
  skills: { name: string; description?: string }[];
  workflows: { id?: string; label: string; description?: string }[];
}
export type CapabilityInstallState = "imported" | "validated" | "approved" | "enabled" | "disabled" | "failed" | "removed";

export interface CapabilitySourceDTO {
  id: string;
  name: string;
  url?: string;
  trusted: boolean;
  updatedAt: number;
}

export interface CapabilityPackDTO {
  id: string;
  sourceId: string;
  framework: "omp" | "workflow" | "flue" | "external";
  slug: string;
  version: string;
  checksum: string;
  title: string;
  description: string;
  requiredEnv: string[];
  tools: { name: string; description?: string }[];
  skills: { name: string; description?: string }[];
  workflows: { id?: string; label: string; description?: string; path?: string }[];
}

export interface CapabilityBindingDTO {
  id: string;
  installId: string;
  type: "profile" | "workflow" | "tool" | "skill" | "driver" | "ui-action" | "preview" | "doc";
  key: string;
  enabled: boolean;
}

export interface CapabilityInstallDTO {
  id: string;
  orgId: string;
  packId: string;
  version: string;
  checksum: string;
  state: CapabilityInstallState;
  bindings: CapabilityBindingDTO[];
  updatedAt: number;
}

export interface CapabilitySnapshotDTO {
  sources: CapabilitySourceDTO[];
  packs: CapabilityPackDTO[];
  installs: CapabilityInstallDTO[];
}

/** One operator-/loop-initiated fleet mutation from the append-only audit log (GET /api/audit). */
export interface AuditEntry {
  /** strictly-increasing id (epoch millis, bumped on collision) — stable sort + dedupe key. */
  id: number;
  /** epoch millis the action resolved. */
  at: number;
  /** who did it — "local" (the auto-loops), "web:admin", etc. */
  actor: string;
  /** land | create | answer | remove | kill | interrupt | set-model | catastrophe | prompt | plan-answer | … */
  action: string;
  /** the work unit acted on (an agent id, usually slug+hash); null for fleet-wide actions. */
  target?: string | null;
  outcome?: "ok" | "error";
  detail?: string;
}

export type SquadEvent =
  | { type: "roster"; agents: AgentDTO[]; version: string }
  | { type: "agent"; agent: AgentDTO }
  | { type: "removed"; id: string }
  | { type: "features-changed" }
  | { type: "comment"; comment: ArtifactCommentDTO }
  | { type: "comment-resolved"; id: string; resolvedAt: number }
  | { type: "transcript"; id: string; entry: TranscriptEntry }
  | { type: "commands"; id: string; commands: CommandInfo[] }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "transition"; entry: TransitionEntry };

export type ClientCommand =
  | { type: "snapshot" }
  | { type: "subscribe"; id: string }
  // `source` (intended values "composer" | "voice", kept as an open string) is observability-only
  // provenance for the audit trail (root ClientCommand/schema, concern 03) — never consulted here
  // for authz/tier decisions, which stay server-side regardless of this tag.
  | { type: "prompt"; id: string; message: string; clientTurnId?: string; displayText?: string; source?: string }
  | { type: "set-model"; id: string; model: string }
  // `source` mirrors "prompt"'s own field (MEDIUM-5: audit source tagging) — observability-only
  // provenance, never consulted here for authz/tier decisions.
  | { type: "interrupt"; id: string; source?: string }
  | { type: "kill"; id: string }
  | { type: "restart"; id: string }
  | { type: "remove"; id: string; deleteWorktree?: boolean }
  | { type: "fork"; id: string; seq?: number };
