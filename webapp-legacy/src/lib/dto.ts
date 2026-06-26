// Mirrors the subset of omp-squad's src/types.ts wire types the webapp consumes.
// Kept as a local copy because webapp/ is a separate package with its own tsconfig.

export type AgentStatus = "starting" | "working" | "idle" | "input" | "error" | "stopped";
export type FeatureStage =
  | "planned" | "issues-created" | "in-progress" | "review" | "diverged" | "landed" | "done";

export interface PendingRequest {
  id: string;
  /** "ui" (confirm/input/select/editor) or "tool" (host tool name). */
  source: "ui" | "tool";
  /** UI method (confirm/input/select/editor) or the host tool name. */
  kind: string;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  createdAt: number;
}

export type TranscriptKind = "user" | "assistant" | "thinking" | "tool" | "system";

export type TranscriptStatus = "running" | "ok" | "error" | "cancelled";
export type TranscriptFormat = "markdown" | "command" | "stage" | "plain";

export interface TranscriptTool {
  callId?: string;
  name: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  resultText?: string;
  partial?: unknown;
  partialText?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface TranscriptPending {
  requestId: string;
  action: "created" | "answered" | "cancelled";
}

export interface TranscriptEntry {
  id?: string;
  seq?: number;
  kind: TranscriptKind;
  text: string;
  ts: number;
  clientTurnId?: string;
  status?: TranscriptStatus;
  tool?: TranscriptTool;
  format?: TranscriptFormat;
  pending?: TranscriptPending;
}

export interface IssueRef {
  id: string;
  identifier?: string;
  name: string;
  state?: string;
  url?: string;
  projectId?: string;
  /** Issue ids that block this one (Plane blocked_by relations). */
  blockedBy?: string[];
  noAutoDispatch?: boolean;
}

export type FeedbackStatus = "new" | "needs-validation" | "accepted" | "promoted" | "rejected";
export type FeedbackKind = "bug" | "feature" | "friction";
export type FeedbackRewardStatus = "none" | "pending" | "approved" | "paid" | "void";
export type FeedbackValidationVote = "valid" | "invalid" | "unsure";

export interface FeedbackCampaign {
  id: string;
  name: string;
  repo: string;
  tokenHash: string;
  allowedOrigins: string[];
  rewardCents?: number;
  rewardCurrency?: string;
  createdAt: number;
  archived?: boolean;
}

export interface FeedbackAttachment {
  id: string;
  kind: "screenshot";
  contentType: "image/png" | "image/jpeg";
  bytes: number;
  path?: string;
  sha256: string;
}

export interface FeedbackItem {
  id: string;
  campaignId: string;
  repo: string;
  kind: FeedbackKind;
  title: string;
  description: string;
  url?: string;
  userId?: string;
  userEmail?: string;
  browser?: string;
  viewport?: string;
  metadata: Record<string, string>;
  attachment?: FeedbackAttachment;
  status: FeedbackStatus;
  rewardStatus: FeedbackRewardStatus;
  planeIssue?: IssueRef;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackValidationResponse {
  id: string;
  feedbackId: string;
  campaignId: string;
  repo: string;
  respondent: string;
  vote: FeedbackValidationVote;
  pain?: number;
  note?: string;
  createdAt: number;
}

export interface FeedbackReward {
  id: string;
  feedbackId: string;
  campaignId: string;
  repo: string;
  amount: number;
  currency: string;
  status: FeedbackRewardStatus;
  provider?: string;
  externalRef?: string;
  reviewer?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackSummary {
  id: string;
  campaignId: string;
  repo: string;
  kind: FeedbackKind;
  title: string;
  status: FeedbackStatus;
  rewardStatus: FeedbackRewardStatus;
  validationCount: number;
  votes: Record<FeedbackValidationVote, number>;
  averagePain?: number;
  hasAttachment: boolean;
  planeIssue?: IssueRef;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackItemsResponse {
  items: FeedbackSummary[];
  raw: FeedbackItem[];
  validations: FeedbackValidationResponse[];
  rewards: FeedbackReward[];
}

/** A concern doc inside a plan dir (mirrors src/features.ts PlanConcern) — a draft task before filing. */
export interface PlanConcern {
  file: string;
  title: string;
  status: string;
  priority?: string;
  complexity?: string;
  /** Set once filed to Plane (the PLANE: pointer); absent ⇒ still a local draft. */
  planeId?: string;
  open: boolean;
}

/** The automation-loop snapshot for a feature (GET /api/features/:id/pipeline). */
export interface FeaturePipeline {
  concerns: PlanConcern[];
  issues: IssueRef[];
  agentIds: string[];
}

export interface FeatureDTO {
  id: string;
  title: string;
  repo: string;
  stage: FeatureStage;
  planDir?: string;
  agentIds: string[];
  unlandedFiles: number;
  divergent: boolean;
  blocked: boolean;
  statusCounts: Partial<Record<AgentStatus, number>>;
  issueIdentifiers?: string[];
  workflowStage?: string;
  workflowProgress?: { done: number; total: number };
}

export interface ReceiptRollup {
  toolCalls: number;
  costUsd?: number;
  durationMs?: number;
  endedAt?: number;
  tokens?: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  runtime: "omp-operator" | "flue-service" | "workflow";
  model?: string;
  approvalMode?: "always-ask" | "write" | "yolo";
  capabilities?: string[];
  memory?: string;
  default?: boolean;
}

export interface AgentSessionSummary {
  id?: string;
  name?: string;
  file?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  interruptMode?: "immediate" | "wait";
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  queuedMessageCount?: number;
  systemPromptLines?: number;
  tools?: { name: string; description?: string }[];
}

export interface TodoPhaseDTO {
  name: string;
  tasks: { content: string; status: "pending" | "in_progress" | "completed" | "abandoned" }[];
}

export interface AgentDTO {
  id: string;
  name: string;
  status: AgentStatus;
  repo: string;
  worktree: string;
  branch?: string;
  model?: string;
  profileId?: string;
  activity?: string;
  todo?: { done: number; total: number; active?: string };
  contextPct?: number;
  receipt?: ReceiptRollup;
  session?: AgentSessionSummary;
  todoPhases?: TodoPhaseDTO[];
  pending: PendingRequest[];
  lastActivity: number;
  error?: string;
  issue?: IssueRef;
  featureId?: string;
  landReady?: boolean;
}

/** Mirrors src/types.ts TaskDetail — a Plane issue with its body parsed into the planner sections. */
export interface TaskDetail {
  id: string;
  identifier?: string;
  name: string;
  state?: string;
  priority?: string;
  labels: string[];
  url?: string;
  blockedBy: string[];
  body: string;
  tier2: { description: string; acceptanceCriteria: string; verification: string; scope: string };
}

/** One fleet-action audit record (subset of src/types.ts AuditEntry). */
export interface AuditEntry {
  at: number;
  actor?: string;
  action: string;
  target?: string;
  outcome?: string;
  detail?: string;
}

export interface FeatureFlagDTO {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  enabled: boolean;
  source: "settings" | "env" | "default";
  restartRequired?: boolean;
}

export interface SettingsDTO {
  featureFlags: FeatureFlagDTO[];
}

/** Manager -> surface events (subset; see src/types.ts SquadEvent). */
export type SquadEvent =
  | { type: "roster"; agents: AgentDTO[]; version: string }
  | { type: "agent"; agent: AgentDTO }
  | { type: "removed"; id: string }
  | { type: "features-changed" }
  | { type: "transcript"; id: string; entry: TranscriptEntry }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "commands"; id: string; commands: CommandInfo[] }
  | { type: "audit"; entry: AuditEntry };

/** A slash command available to an agent (subset of src/types.ts CommandInfo). */
export interface CommandInfo {
  name: string;
  description?: string;
  aliases?: string[];
  hint?: string;
  source?: string;
}

/** Surface -> manager commands (subset we send). */
export type ClientCommand =
  | { type: "snapshot" }
  | { type: "subscribe"; id: string }
  | { type: "prompt"; id: string; message: string; clientTurnId?: string }
  | { type: "set-model"; id: string; model: string }
  | { type: "answer"; id: string; requestId: string; value: string }
  | { type: "interrupt"; id: string }
  | { type: "kill"; id: string }
  | { type: "restart"; id: string }
  | { type: "remove"; id: string; deleteWorktree?: boolean };
