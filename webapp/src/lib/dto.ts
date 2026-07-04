export type AgentStatus = "starting" | "working" | "idle" | "input" | "error" | "stopped";
export type FeatureStage = "planned" | "issues-created" | "in-progress" | "review" | "diverged" | "landed" | "done";
export type WorktreeProofState = "none" | "failed" | "stale" | "fresh";


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
}

export interface FeatureCriterionDTO {
  id: string;
  text: string;
  completed: boolean;
  source?: "plan" | "ticket" | "workflow" | "manual";
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

export interface PlanAnnotationTargetDTO {
  planPath: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: string;
  /** Anchors the annotation to a specific rendered plan block (data-block-id). Additive/optional. */
  blockId?: string;
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
  worktrees: FeatureWorktreeStatusDTO[];
  unlandedFiles: number;
  divergent: boolean;
  blocked: boolean;
  statusCounts: Partial<Record<AgentStatus, number>>;
  issueIdentifiers?: string[];
  persisted?: boolean;
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

export type TraceSpanKindDTO = 'run' | 'node' | 'tool' | 'subagent' | 'verify' | 'land' | 'resolve';
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
  /** True when at least one receipt kept only its rollup because fine spans were sampled out —
   *  the span waterfall below `rollup` is then labeled "sampled — partial". */
  partial: boolean;
}

export interface AgentDTO {
  id: string;
  name: string;
  status: AgentStatus;
  /** Which runtime backs this agent. */
  kind?: AgentKind;
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
  session?: AgentSessionSummaryDTO;
  profileId?: string;
  activity?: string;
  todo?: { done: number; total: number; active?: string };
  todoPhases?: TodoPhaseDTO[];
  pending: PendingRequest[];
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
  blockedReason?: string;
  availableActions: AgentAction[];
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
  | { type: "prompt"; id: string; message: string; clientTurnId?: string }
  | { type: "set-model"; id: string; model: string }
  | { type: "interrupt"; id: string }
  | { type: "kill"; id: string }
  | { type: "restart"; id: string }
  | { type: "remove"; id: string; deleteWorktree?: boolean }
  | { type: "fork"; id: string; seq?: number };
