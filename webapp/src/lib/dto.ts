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

export interface TranscriptEntry {
  kind: TranscriptKind;
  text: string;
  ts: number;
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

export interface AgentDTO {
  id: string;
  name: string;
  status: AgentStatus;
  repo: string;
  worktree: string;
  branch?: string;
  model?: string;
  activity?: string;
  todo?: { done: number; total: number; active?: string };
  contextPct?: number;
  pending: PendingRequest[];
  lastActivity: number;
  error?: string;
  issue?: IssueRef;
  featureId?: string;
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
  | { type: "prompt"; id: string; message: string }
  | { type: "answer"; id: string; requestId: string; value: string }
  | { type: "interrupt"; id: string }
  | { type: "kill"; id: string }
  | { type: "restart"; id: string }
  | { type: "remove"; id: string; deleteWorktree?: boolean };
