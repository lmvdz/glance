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

export interface AgentDTO {
  id: string;
  name: string;
  status: AgentStatus;
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
  | { type: "log"; level: "info" | "warn" | "error"; text: string };

export type ClientCommand =
  | { type: "snapshot" }
  | { type: "subscribe"; id: string }
  | { type: "prompt"; id: string; message: string; clientTurnId?: string; displayText?: string }
  | { type: "set-model"; id: string; model: string }
  | { type: "interrupt"; id: string }
  | { type: "kill"; id: string }
  | { type: "restart"; id: string }
  | { type: "remove"; id: string; deleteWorktree?: boolean };
