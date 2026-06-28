/**
 * Shared domain + wire types for omp-squad.
 *
 * The SquadManager owns the authoritative in-memory roster (AgentRecord).
 * Surfaces (TUI, web) consume serializable snapshots (AgentDTO) and the
 * SquadEvent stream, and send ClientCommand back.
 */

import type { RpcExtensionUIRequest, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { WorkflowRunState } from "./workflow/types.ts";
import type { Span } from "./spans.ts";

/** Derived, human-meaningful lifecycle state of one managed agent. */
export type AgentStatus =
	| "starting" // process spawned, awaiting the RPC `ready` frame
	| "working" // an agent turn is actively streaming
	| "idle" // ready, turn finished, awaiting the next instruction
	| "input" // BLOCKED on a human decision (approval / question / tool input)
	| "error" // spawn failed, child crashed, or fatal RPC error
	| "stopped"; // intentionally terminated

/**
 * Which runtime backs a managed agent.
 *  - "omp-operator": an `omp --mode rpc` child in a git worktree (interactive, steerable).
 *  - "flue-service": a Flue worker invoked via `flue run` (autonomous / bounded).
 *  - "workflow": a graph-driven, gated, multi-stage run over a persistent omp thread.
 */
export type AgentKind = "omp-operator" | "flue-service" | "workflow";

/** A request from the agent that a human must answer before it can proceed. */
export interface PendingRequest {
	/** Correlates with the answer the surface sends back. */
	id: string;
	/** Where it came from. */
	source: "ui" | "tool";
	/** UI method (confirm/input/select/editor) or the host tool name. */
	kind: string;
	title: string;
	/** confirm message / tool argument summary. */
	message?: string;
	/** select options. */
	options?: string[];
	/** input placeholder / editor prefill. */
	placeholder?: string;
	createdAt: number;
}

export type TranscriptKind = "user" | "assistant" | "thinking" | "tool" | "system";

export type TranscriptStatus = "running" | "ok" | "error" | "cancelled";

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

export type TranscriptFormat = "markdown" | "command" | "stage" | "plain";

export interface TranscriptEntry {
	/** Stable append id. Older persisted transcripts may not have one. */
	id?: string;
	/** Monotonic manager-local sequence. Older persisted transcripts may not have one. */
	seq?: number;
	kind: TranscriptKind;
	text: string;
	ts: number;
	/** Echoes a UI-submitted prompt id so optimistic turns reconcile without text matching. */
	clientTurnId?: string;
	status?: TranscriptStatus;
	tool?: TranscriptTool;
	format?: TranscriptFormat;
	pending?: TranscriptPending;
}

/** A work item (e.g. a Plane issue) an agent is advancing. */
export interface IssueRef {
	/** Provider issue id. */
	id: string;
	/** Human identifier, e.g. "DAGON-263". */
	identifier?: string;
	name: string;
	state?: string;
	/** Provider priority when present. Dispatcher uses this only for ordering, never as a safety override. */
	priority?: "urgent" | "high" | "medium" | "low" | "none" | string;
	url?: string;
	/** Provider project id this issue belongs to. */
	projectId?: string;
	/** Issue ids that block this one (Plane `blocked_by` relations). Dispatch defers the issue while any blocker is still open. */
	blockedBy?: string[];
	/** Name flags this issue for human review / do-NOT-auto-land (e.g. SECURITY-CRITICAL). The dispatcher
	 *  skips it (never auto-dispatched/auto-landed), but it still appears in the UI's issue list. */
	noAutoDispatch?: boolean;
}

// ── Feedback Loop domain/wire types ─────────────────────────────────────────

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

/** A Plane issue resolved with its body for the planner task view — the promote-issue Tier-2
 *  schema parsed into the sections the UI shows (description / acceptance criteria / verification /
 *  scope) plus display properties. Returned by GET /api/tasks/:id. */
export interface TaskDetail {
	id: string;
	identifier?: string;
	name: string;
	state?: string;
	priority?: string;
	labels: string[];
	url?: string;
	blockedBy: string[];
	/** Clean text of the issue body (Plane `description_stripped`) — fallback render. */
	body: string;
	/** Parsed promote-issue Tier-2 sections; each "" when absent (see src/tier2.ts). */
	tier2: { description: string; acceptanceCriteria: string; verification: string; scope: string };
}

/** A feature's associated Plane issue, resolved for display: status group + deep link. */
export interface PlaneTicket {
	identifier: string;
	name: string;
	/** Plane state group: backlog | unstarted | started | completed | cancelled | unknown. */
	status: string;
	/** Deep link into the Plane web app. */
	url: string;
}

/** A project / workstream — the top level of the command center. Derived from agents' repos. */
export interface ProjectDTO {
	/** Stable id = repo root path. */
	id: string;
	name: string;
	repo: string;
	agentCount: number;
	statusCounts: Partial<Record<AgentStatus, number>>;
	pendingCount: number;
	lastActivity: number;
}

/** Lifecycle stage of a feature — derived from observable evidence (plan dir, agents, land status). */
export type FeatureStage = "planned" | "issues-created" | "in-progress" | "review" | "diverged" | "landed" | "done";

/** Per-branch land readiness — the heart of the "needs Land to test" / "can't cleanly land" signal. */
export type LandReadiness = "clean" | "uncommitted" | "ahead" | "diverged" | "merged" | "no-branch";

/** Land-proof rollup for one member worktree — see src/proof.ts. */
export interface WorktreeProofSummary {
	/** none = no proof recorded; failed = ran but did not pass; stale = passed but HEAD moved; fresh = passed against current HEAD. */
	state: "none" | "failed" | "stale" | "fresh";
	/** When the recorded proof last ran (ms epoch), if any. */
	ranAt?: number;
	/** Count of collected screenshot artifacts (vision evidence). */
	artifacts: number;
}

/** Live land status of one member worktree/branch vs. main. */
export interface FeatureWorktreeStatus {
	agentId?: string;
	agentName?: string;
	branch?: string;
	worktree: string;
	/** Unlanded changed files in the worktree (same count as /api/agents/:id/diff). */
	changedFiles: number;
	/** Commits on the branch not in main. */
	ahead: number;
	/** Commits on main not in the branch (divergence signal). */
	behind: number;
	readiness: LandReadiness;
	/** Land-proof rollup (additive; absent on synthetic statuses that don't compute it). */
	proof?: WorktreeProofSummary;
}

export interface FeatureCriterion {
	id: string;
	text: string;
	completed: boolean;
	source?: "plan" | "ticket" | "workflow" | "manual";
}

export interface FeatureDecision {
	id: string;
	text: string;
	source?: "plan" | "human" | "agent";
	createdAt?: number;
}

export interface FeatureRelationship {
	id: string;
	targetId: string;
	targetTitle: string;
	type?: "issue" | "blocks" | "depends-on" | "related";
	url?: string;
}

export interface FeatureContextSummary {
	spec: string;
	criteria: string;
	prerequisites: string;
	decisions: string;
	downstream: string;
}

export type FeatureReadinessState = "no-candidate" | "needs-proof" | "proof-failed" | "proof-stale" | "blocked-input" | "diverged" | "ready" | "landed/done";

export interface FeatureReadiness {
	/** True only when landable branches are cleanly landable and freshly proved. */
	ready: boolean;
	state: FeatureReadinessState;
	/** Short machine-readable blocker codes for filtering and disabled-button reasons. */
	blockers: string[];
	/** One operator-facing next step. */
	nextAction: string;
}

/**
 * A Feature — a cross-cutting unit of work spanning a plan dir and/or a set of agents/worktrees.
 * Phase 1: fully DERIVED at read time (no persistence) from plan dirs + the roster + live git.
 */
export interface FeatureDTO {
	/** Stable derived id: `plan:<repo>:<dir>` or `agent:<agentId>`. */
	id: string;
	title: string;
	createdAt?: number;
	updatedAt?: number;
	repo: string;
	stage: FeatureStage;
	/** Repo-relative plan dir this feature originated from, if any. */
	planDir?: string;
	/** Roster agent ids that belong to this feature. */
	agentIds: string[];
	/** Per-branch land status for member worktrees. */
	worktrees: FeatureWorktreeStatus[];
	/** Σ changedFiles across member worktrees — the board's amber "unlanded" number. */
	unlandedFiles: number;
	/** Any member worktree readiness === "diverged". */
	divergent: boolean;
	/** Any member agent is waiting on human input. */
	blocked: boolean;
	statusCounts: Partial<Record<AgentStatus, number>>;
	/** Plane issue identifiers referenced by this feature's plan concerns, if any. */
	issueIdentifiers?: string[];
	/** True when this is a real persisted Feature (vs a derived agent/plan-dir feature). */
	persisted?: boolean;
	/** Manual stage pin (persisted features only). */
	stageOverride?: FeatureStage;
	archived?: boolean;
	/** When Fabro-driven: the research-plan-implement workflow agent running this feature. */
	workflowAgentId?: string;
	/** Live label of the workflow's active node (e.g. "Implement"), when workflow-driven. */
	workflowStage?: string;
	/** Workflow node rollup (completed/total) for a progress bar. */
	workflowProgress?: { done: number; total: number };
	/** Freshness of the workflow milestone proof backing any automatic land. */
	workflowProof?: WorktreeProofSummary;
	/** Human-readable description exposed in the React task detail pane. */
	description?: string;
	/** Acceptance criteria from plan docs / tickets / workflow / manual edits. */
	acceptanceCriteria?: FeatureCriterion[];
	/** Durable decision log entries that should be fed to agents. */
	decisions?: FeatureDecision[];
	/** Linked issues/features/docs. */
	relationships?: FeatureRelationship[];
	/** Deterministic promotion/land explanation for operators and API clients. */
	readiness: FeatureReadiness;
	/** Precomputed context bundle summary for task-detail display and agent prompts. */
	contextBundle?: FeatureContextSummary;
}

export interface PlanAnnotationTarget {
	planPath: string;
	lineStart?: number;
	lineEnd?: number;
	quote?: string;
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
	annotation?: PlanAnnotationTarget;
	resolvedAt?: number;
}


export interface AgentProfile {
	id: string;
	name: string;
	description?: string;
	runtime: AgentKind;
	model?: string;
	approvalMode?: ApprovalMode;
	capabilities?: string[];
	memory?: string;
	default?: boolean;
}

export interface AgentSessionSummary {
	id?: string;
	name?: string;
	file?: string;
	thinkingLevel?: ThinkingLevel;
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

/** Serializable per-agent snapshot sent to surfaces. */
export interface AgentDTO {
	id: string;
	name: string;
	status: AgentStatus;
	/** Which runtime backs this agent. */
	kind: AgentKind;
	/** Parent workflow agent id, when this agent is a spawned fan-out branch. */
	parentId?: string;
	/** flue-service only: passed the acceptance gate at onboard time. */
	verified?: boolean;
	/** Repo root the worktree was cut from (host-local path; for display). */
	repo: string;
	/** Cross-host repo identity (normalized git origin — see repo-identity.ts). OPTIONAL: when
	 *  absent, federation derives it lazily from `repo`. Carrying it on the DTO lets a peer's
	 *  presence frame, gossiped over the wire, be collision-matched against ours without each host
	 *  re-running git on the other's path (which it can't reach). */
	repoId?: string;
	/** Absolute path of this agent's git worktree (its cwd). */
	worktree: string;
	branch?: string;
	model?: string;
	profileId?: string;
	approvalMode: ApprovalMode;
	/** One-line description of what it's doing right now (tool name / activity). */
	activity?: string;
	/** Latest todo summary "done/total" + active task text. */
	todo?: { done: number; total: number; active?: string };
	/** ms epoch when this agent began working — the anchor for the completion estimate. */
	startedAt?: number;
	/** Rough estimated completion time (ms epoch) from progress rate; absent until there's progress. A hint, not a deadline. */
	etaAt?: number;
	/** Context window usage 0..1. */
	contextPct?: number;
	/** Approximate tokens currently in the context window. */
	contextTokens?: number;
	/** Model context window size in tokens. */
	contextWindow?: number;
	/** Compact rollup of the latest/in-flight run (tools, cost, duration); live/derived. */
	receipt?: ReceiptRollup;
	/** Compact live RPC session metadata for Control Tower parity with the TUI. */
	session?: AgentSessionSummary;
	/** Current todo phases from the backing harness, preserved for rich web rendering. */
	todoPhases?: RpcSessionState["todoPhases"];
	/** Pending human-input requests (status === "input" when non-empty). */
	pending: PendingRequest[];
	/** ms epoch of last activity of any kind. */
	lastActivity: number;
	/** Number of transcript entries (for cheap change detection). */
	messageCount: number;
	/** Last error string, if status === "error". */
	error?: string;
	/** Work item this agent is advancing (e.g. a Plane issue). */
	issue?: IssueRef;
	/** Feature this agent belongs to (single source of truth for membership). */
	featureId?: string;
	/** Repo-relative path prefixes this agent owns — overlapping spawns are refused (partition). */
	owns?: string[];
	/** Workflow definition backing this agent, when kind === "workflow". */
	workflow?: WorkflowMemberConfig;
	/** Live workflow checkpoint/rollup, emitted on every stage boundary. */
	workflowState?: WorkflowRunState;
	/** Verified by the auto-land loop in confirm mode; awaiting a one-tap Land. */
	landReady?: boolean;
	/** Re-adopted from a surviving worktree on relaunch and not yet re-run (OMPSQ-164): its work was
	 *  complete before the stop, so the event-driven auto-land never fires. The orchestrator lands such
	 *  an agent directly (merge→gate→rollback) instead of an isolated worktree pre-verify. Cleared the
	 *  moment it actually runs again (a turn starts). */
	adopted?: boolean;
	/** True only on the synthetic DTO `create()` returns when a spawn is parked at the WIP cap (OMP_SQUAD_QUEUE_ON_FULL). Never set on a roster agent. */
	queued?: boolean;
}

/**
 * Durable per-run record (one JSONL line per completed/terminated agent run).
 * Tokens/costUsd are OPTIONAL — omitted when no assistant usage was seen.
 */
export interface RunReceipt {
	agentId: string;
	name: string;
	repo: string;
	branch?: string;
	model?: string;
	runId: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	status: AgentStatus;
	toolCalls: number;
	toolTally: Record<string, number>;
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	costUsd?: number;
	filesTouched: string[];
	/** Trace grouping id: `feat:<featureId>` for feature work, else `run:<agentId>:<runId>`. */
	traceId?: string;
	/** Fine-grained run spans. Tail-sampled; receipt rollups above are never sampled. */
	spans?: Span[];
	/** Feature/parent ids copied onto receipts so trace trees survive agent removal. */
	featureId?: string;
	parentId?: string;
}

/** Compact run summary carried on the DTO for the dashboard. */
export interface ReceiptRollup {
	toolCalls: number;
	costUsd?: number;
	durationMs?: number;
	endedAt?: number;
	/** Total tokens across the run (sum of input/output/cache); absent when no usage seen. */
	tokens?: number;
}

export type ApprovalMode = "always-ask" | "write" | "yolo";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Persisted across restarts in ~/.omp/squad/state.json. */
export interface PersistedAgent {
	id: string;
	name: string;
	repo: string;
	worktree: string;
	branch?: string;
	model?: string;
	profileId?: string;
	approvalMode: ApprovalMode;
	/** Initial task prompt, if the agent was created with one. */
	task?: string;
	/** Extra system-prompt text appended for specialized surfaces, e.g. console chat. */
	appendSystemPrompt?: string;
	thinking?: ThinkingLevel;
	issue?: IssueRef;
	featureId?: string;
	/** Runtime class; defaults to "omp-operator" when absent (back-compat). */
	kind?: AgentKind;
	/** Agent runtime: "omp" (omp --mode rpc, default) or "acp" (an ACP runtime, e.g. auggie --acp). */
	runtime?: "omp" | "acp";
	/** flue-service only: worker invocation config. */
	flue?: FlueMemberConfig;
	/** workflow only: graph file backing this run. */
	workflow?: WorkflowMemberConfig;
	/** workflow only: resumable run position, persisted so a daemon restart can continue the graph. */
	workflowState?: WorkflowRunState;
	/** Parent workflow agent id, when this is a spawned fan-out branch. */
	parentId?: string;
	/** When set, run this agent inside a container instead of locally. */
	sandbox?: SandboxConfig;
	/** Repo-relative path prefixes this agent owns — restored so partition survives a restart. */
	owns?: string[];
}

/** Persisted feature envelope — additive `features[]` in ~/.omp/squad/state.json. */
export interface PersistedFeature {
	id: string;
	title: string;
	repo: string;
	/** Manual stage pin; otherwise the stage is fully derived. */
	stageOverride?: FeatureStage;
	/** Repo-relative provenance. */
	origin?: { planDir?: string; briefPath?: string };
	plane?: { moduleId?: string; moduleUrl?: string; issueIdentifiers?: string[] };
	/** Deterministic acceptance command (exit 0 = pass) that gates landing. Defaults to the repo's detected verify command. */
	acceptance?: string;
	/** Snapshot of member branches so land status survives an agent being killed. */
	branches?: { branch?: string; worktree: string; agentId?: string }[];
	createdAt: number;
	updatedAt: number;
	archived?: boolean;
	/** When Fabro-driven: the research-plan-implement workflow agent running this feature. */
	workflowAgentId?: string;
	description?: string;
	acceptanceCriteria?: FeatureCriterion[];
	decisions?: FeatureDecision[];
	relationships?: FeatureRelationship[];
	contextBundle?: Partial<FeatureContextSummary>;
}

/** Options when adding an agent to the squad. */
export interface CreateAgentOptions {
	name?: string;
	repo: string;
	/** Agent runtime: "omp" (omp --mode rpc, default) or "acp" (an ACP runtime, e.g. auggie --acp). */
	runtime?: "omp" | "acp";
	/** Branch to create/checkout for the worktree. Defaults to `squad/<name>`. */
	branch?: string;
	/** Reuse an existing path as the cwd instead of cutting a worktree. */
	existingPath?: string;
	model?: string;
	profileId?: string;
	approvalMode?: ApprovalMode;
	/** Prompt to send immediately once the agent is ready. */
	task?: string;
	/** Extra system-prompt text appended for specialized surfaces, e.g. console chat. */
	appendSystemPrompt?: string;
	/** Reasoning effort for this agent (defaults to "low" so fleet agents stay responsive). */
	thinking?: ThinkingLevel;
	/** Work item to advance (shown in the command center; e.g. a Plane issue). */
	issue?: IssueRef;
	/** Feature to attach this agent to on creation. */
	featureId?: string;
	/** Path to a workflow graph (`.fabro`) to run as the agent's process; `task` becomes the goal. */
	workflow?: string;
	/** Capability-backed flue-service invocation. */
	flue?: FlueMemberConfig;
	/** Resumable workflow checkpoint to continue from instead of restarting the graph (adopt/restore paths). */
	workflowState?: WorkflowRunState;
	/** Verification command: wrap `task` in an implement → verify → fixup loop. */
	verify?: string;
	/** Parent workflow agent id, when spawning a fan-out branch. */
	parentId?: string;
	/** Run this agent inside a container (sandboxed execution); mounts the worktree by default. */
	sandbox?: SandboxConfig;
	/** Auto-pick a process (verify / plan-approve / fan-out) from the task. Default on; false = plain agent. */
	autoRoute?: boolean;
	/** Repo-relative path prefixes this agent will edit. A spawn whose paths overlap a live agent's is refused. */
	owns?: string[];
	/** Auto-create + attach a tracking Plane issue for this spawn (work→Plane). Set at human/dispatch spawn entry points; off for restore/fan-out. */
	track?: boolean;
	/** Skip the global live-agent WIP cap (restore / fan-out paths that recreate already-accounted-for agents). */
	bypassCap?: boolean;
	/** Re-created from a surviving worktree during restart adoption (OMPSQ-164). Marks the agent so the
	 *  orchestrator auto-lands its already-complete work directly, since the event-driven auto-land that
	 *  fires on a run-to-completion never re-fires for an adopted agent that doesn't re-run. */
	adopted?: boolean;
}

/** Sandboxed execution: run the agent's omp inside a container. */
export interface SandboxConfig {
	/** Container image (an omp-provisioned image for real runs). */
	image: string;
	/** Working dir inside the container. Default `/work`. */
	workdir?: string;
	/** Bind-mount the worktree into the container (default true); false = fully isolated fs. */
	mountWorktree?: boolean;
	/** Extra `docker run` args, e.g. `["--network=none"]`. */
	runArgs?: string[];
}

// ── Commissioning (agents that author agents) ────────────────────────────────

/** flue-service only: how to invoke the worker's workflow. */
export interface FlueMemberConfig {
	/** Worker project directory (its cwd). */
	dir: string;
	/** Flue workflow module name to invoke (e.g. "extract-emails"). */
	workflow: string;
	/** Deploy/run target. */
	target: "node" | "cloudflare";
}

/** A verification gate wrapped around a task: run `command`, loop into fixup on failure. */
export interface VerifySpec {
	/** Shell command whose exit code is the gate (0 = pass). */
	command: string;
	/** Max fix-up turns before giving up (default 3). */
	maxFixups?: number;
}

/** workflow only: the graph backing a workflow run — an authored file or a synthesized verify loop. */
export interface WorkflowMemberConfig {
	/** Path to an authored workflow graph file (`.fabro` / `.dot`). */
	path?: string;
	/** Synthesized verify-loop spec (mutually exclusive with `path`). */
	verify?: VerifySpec;
}

/** A job spec handed to the commissioning loop — the "job description". */
export interface CommissionSpec {
	/** Kebab worker name; becomes the Flue workflow + module name. */
	name: string;
	/** The ability this worker compartmentalizes (the JD). */
	purpose: string;
	/** Model specifier, or false for a deterministic (no-LLM) worker. */
	model?: string | false;
	/** Least-privilege tool/skill allowlist, recorded in the worker manifest. */
	capabilities?: string[];
	/** Deploy/run target. Defaults to "node". */
	deployTarget?: "node" | "cloudflare";
	/** TemplateArchitect: the run() body to splice into the workflow. */
	workflowBody?: string;
	/** Acceptance check — the "interview" the candidate must pass to be onboarded. */
	accept?: { payload: unknown; expect?: Record<string, unknown> };
}

/** One acceptance-gate check result. */
export interface GateCheck {
	name: "lint" | "typecheck" | "acceptance" | "ponytail";
	status: "pass" | "fail" | "skip";
	detail?: string;
}

/** Outcome of the acceptance gate. */
export interface GateReport {
	ok: boolean;
	checks: GateCheck[];
	/** acceptance result payload, when the acceptance check ran. */
	result?: unknown;
}

/** Outcome of a commission() call. */
export interface CommissionResult {
	ok: boolean;
	report: GateReport;
	/** The onboarded fleet member, when ok. */
	member?: AgentDTO;
	/** Worker project directory. */
	dir: string;
}

/** A slash command available to an omp-operator agent (builtin / skill / extension / custom). */
export interface CommandInfo {
	/** Command name without the leading slash (e.g. "plan", "skill:ponytail", "rtk"). */
	name: string;
	description?: string;
	aliases?: string[];
	/** Argument hint shown after the name (from the command's `input.hint`). */
	hint?: string;
	/** Where it comes from: "builtin" | "skill" | "extension" | "custom" | "file". */
	source?: string;
}

// ── Manager → surface events ────────────────────────────────────────────────

export type SquadEvent =
	| { type: "roster"; agents: AgentDTO[]; version: string }
	| { type: "agent"; agent: AgentDTO }
	| { type: "removed"; id: string }
	| { type: "transcript"; id: string; entry: TranscriptEntry }
	| { type: "log"; level: "info" | "warn" | "error"; text: string }
	| { type: "commands"; id: string; commands: CommandInfo[] }
	| { type: "features-changed" }
	| { type: "comment"; comment: ArtifactCommentDTO }
	| { type: "comment-resolved"; id: string; resolvedAt: number }
	| { type: "audit"; entry: AuditEntry }
	| { type: "automation"; event: AutomationEvent };

/** The daemon's periodic background loops — the ones that run without an operator and were, until the
 *  automation log, invisible. Scout reads agent reasoning (the only token-spending loop); Observer and
 *  Opportunity run pure/zero-token checks; Dispatcher polls Plane and spawns routed agents. */
export type AutomationLoop = "scout" | "observer" | "opportunity" | "dispatch";

/**
 * One unit of background-loop work, the observability record the audit log never carried (it logs only
 * operator-initiated mutations). Scout emits one per reasoning scan (each = one LLM call); the other
 * loops emit one per tick (a no-op tick is a heartbeat that proves the loop is alive). See automation-log.ts.
 */
export interface AutomationEvent {
	/** Strictly-increasing id (epoch millis, bumped on collision); stable sort + dedupe key. */
	id: number;
	/** Epoch millis the unit of work finished. */
	at: number;
	loop: AutomationLoop;
	/** Repo the loop is scoped to (Scout/Observer/Opportunity are per-repo); omitted for fleet-wide Dispatch. */
	repo?: string;
	/** Scout only: the agent whose reasoning was scanned. */
	agent?: string;
	/** Wall-clock the unit took. */
	durationMs?: number;
	/** LLM one-shots this unit cost — Scout: 1 per scan; the other loops: 0. The headline cost signal. */
	llmCalls?: number;
	/** Candidates/findings surfaced this unit (before dedup). */
	found?: number;
	/** Issues/tickets actually filed this unit. */
	filed?: number;
	/** Candidates skipped as already-seen / duplicate of open work. */
	deduped?: number;
	/** Dispatch only: agents spawned this tick. */
	spawned?: number;
	/** Severity of the unit; "warn"/"error" force the event onto disk even with no work done. */
	level?: "info" | "warn" | "error";
	/** Optional human-readable detail (a filed title, an error message). */
	detail?: string;
}

/** One append-only fleet-action audit record (actor / action / target / outcome). */
export interface AuditEntry {
	/** Strictly-increasing id (epoch millis, bumped on collision); stable sort + dedupe key. */
	id: number;
	/** Epoch millis the action resolved. */
	at: number;
	/** Who initiated it — an `Actor.id` ("local", "web:admin", "auto-supervise", a tailnet login…). */
	actor: string;
	/** What they did: create | prompt | answer | interrupt | kill | restart | remove | commission | land | message. */
	action: string;
	/** What it acted on (agent id, worker name, feature id) — null for fleet-wide actions. */
	target: string | null;
	/** Result of the action once it resolved. */
	outcome: "ok" | "error";
	/** Optional human-readable detail (truncated message, error text). */
	detail?: string;
}

// ── Surface → manager commands ──────────────────────────────────────────────

export type ClientCommand =
	| { type: "prompt"; id: string; message: string; clientTurnId?: string }
	| { type: "set-model"; id: string; model: string }
	| { type: "answer"; id: string; requestId: string; value: string }
	| { type: "interrupt"; id: string }
	| { type: "kill"; id: string }
	| { type: "restart"; id: string }
	| { type: "remove"; id: string; deleteWorktree?: boolean }
	| { type: "create"; options: CreateAgentOptions }
	| { type: "message"; to: string; text: string }
	| { type: "snapshot" } // request a full roster + recent transcript replay
	| { type: "subscribe"; id: string } // ask for transcript replay of one agent
	| { type: "commission"; spec: CommissionSpec };

// ── Federation (Phase 2): cross-operator coordination ───────────────────────

/** Availability of a human operator, used for delegation / away-mode auto-grant. */
export type Availability = "active" | "away" | "offline";

/** RBAC capability tier. Ascending: `viewer` ⊂ `operator` ⊂ `admin`. */
export type Role = "viewer" | "operator" | "admin";

/** Verified actor that issued a command (identity from the federation transport). */
export interface Actor {
	/** Stable id, e.g. tailnet login "bob@company.com" or "local". */
	id: string;
	displayName?: string;
	/** "local" for same-machine surfaces, "remote" for federation peers, "agent" for authenticated agent-host tool calls. */
	origin: "local" | "remote" | "agent";
	/** RBAC tier this actor holds. Absent ⇒ derived from origin: local surfaces are
	 *  trusted (admin), remote peers and agent-origin actors are read-only (viewer).
	 *  Agents do NOT gain capabilities through this tier; applyCommand has a message-only allowlist. */
	role?: Role;
	/** Org whose fleet this actor acts on (DB mode). Absent ⇒ file mode / no active org. */
	orgId?: string;
}

/** One operator's published state in a team room. */
export interface OperatorPresence {
	operator: Actor;
	availability: Availability;
	host?: string;
	agents: AgentDTO[];
	updatedAt: number;
}

export type { RpcSessionState, RpcExtensionUIRequest };
