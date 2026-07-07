/**
 * Shared domain + wire types for omp-squad.
 *
 * The SquadManager owns the authoritative in-memory roster (AgentRecord).
 * Surfaces (TUI, web) consume serializable snapshots (AgentDTO) and the
 * SquadEvent stream, and send ClientCommand back.
 */

import type { RpcExtensionUIRequest, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { WorkflowGraphSnapshot, WorkflowRunState } from "./workflow/types.ts";
import type { Span } from "./spans.ts";
import type { AgentAction, AutonomyMode, VerificationState } from "./autonomy.ts";
import type { TransitionReason } from "./agent-lifecycle.ts";
import type { SubagentNode } from "./subagents.ts";
import type { ModelLineage } from "./model-lineage.ts";

/** Derived, human-meaningful lifecycle state of one managed agent. */
export type AgentStatus =
	| "starting" // process spawned, awaiting the RPC `ready` frame
	| "working" // an agent turn is actively streaming
	| "idle" // ready, turn finished, awaiting the next instruction
	| "input" // BLOCKED on a human decision (approval / question / tool input)
	| "error" // spawn failed, child crashed, or fatal RPC error
	| "stopped"; // intentionally terminated

/** One recorded (or denied) `{from,to,reason,at}` transition — the persisted shape written to
 *  `transitions.jsonl` (src/jsonl-log.ts) and mirrored in SquadManager's in-memory ring. */
export interface TransitionEntry {
	agentId: string;
	from: AgentStatus;
	to: AgentStatus;
	reason: TransitionReason;
	at: number;
	cause?: { error?: string; priorId?: string; [k: string]: unknown };
	denied?: true;
	/** Set by concern 04's settle-window pending tagging (not used on TransitionEntry itself in this
	 *  concern, but reserved on the shared cause shape for forward-compat — not implemented here). */
	replayed?: true;
	/** Globally-unique identity for THIS entry (a uuid, not a counter — a per-process monotonic counter
	 *  would collide across a restart boundary, exactly where dedupeTransitions's merge of the persisted
	 *  file with the freshly-hydrated ring needs identity to be trustworthy). dedupeTransitions() keys on
	 *  this when present, falling back to the old (agentId,at,reason) composite for entries written before
	 *  this field existed (#lifecycle-truth finding 7: that composite collapses distinct same-millisecond
	 *  transitions — e.g. closeOrphanedPending's several pending-cancel entries in one adopt — so `full=1`
	 *  could return FEWER entries than the capped ring view). Optional so old transitions.jsonl lines
	 *  (no `seq`) still parse and hydrate. */
	seq?: string;
}

/**
 * Which runtime backs a managed agent.
 *  - "omp-operator": an `omp --mode rpc` child in a git worktree (interactive, steerable).
 *  - "flue-service": a Flue worker invoked via `flue run` (autonomous / bounded).
 *  - "workflow": a graph-driven, gated, multi-stage run over a persistent omp thread.
 */
export type AgentKind = "omp-operator" | "flue-service" | "workflow";

/** Specialization of a coding unit, orthogonal to AgentKind. Absent = general coder. */
export type ExecutionRole = "tester" | "observer";

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
	/** True for a real workflow gate (raiseGate's gate_-id requests, or a GATE:-prefixed title) — never
	 *  auto-answered by maybeAutoSupervise or the external supervisor, regardless of budget/risk text. */
	gateClass?: boolean;
	/** Set when this request was (re)created from an agent-host ring replay during the post-reattach
	 *  settle window, not a fresh live request. Used ONLY by the two ghost-expiry rules below — never
	 *  gates answerability (a replayed pending IS answerable; the waiter lives in the surviving host). */
	replayed?: true;
}

/**
 * A non-blocking "I'm unsure — here's a proposal" note (Epic 5 DESIGN §D2). Raised by the agent via
 * the `squad_report` host tool, or auto-synthesized by the manager when a run finalizes below the
 * confidence floor. Appended to `AgentDTO.reports` — deliberately NOT a `PendingRequest`, so it never
 * blocks the agent or flips its status to "input".
 */
export interface AgentReport {
	id: string;
	summary: string;
	/** Optional proposed diff/summary of what the agent would do next, for a human to review. */
	proposal?: string;
	/** The confidence score (if any) that prompted this report; absent for a manually-raised report. */
	confidence?: number;
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
	/**
	 * The user's bare typed text, when it differs from `text` (e.g. `text` carries the
	 * full context-augmented message the agent actually received — fleet snapshot, live
	 * context, etc — while this is what they typed). UI renders this when present, but
	 * `text` remains the durable audit/debug record of what the agent was actually given.
	 */
	displayText?: string;
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
	/** Repo-relative path prefixes this issue reads before it can run. Operator-declared values are dispatch-enforced. */
	requires?: string[];
	/** Repo-relative path prefixes this issue owns/edits. */
	owns?: string[];
	/** Repo-relative path prefixes this issue will write/create. Defaults to `owns`. */
	produces?: string[];
	/** Whether the issue scope contract came from an operator or planner inference. */
	scopeSource?: ScopeSource;
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
	/** Uncommitted changed files in the worktree (drives the `uncommitted` readiness state).
	 *  Distinct from /api/agents/:id/diff, which shows everything changed since the fork point
	 *  (committed + uncommitted) so the review panel survives the unit committing. */
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

/**
 * Epic 3 (independent validator) — the result of scoring a landed diff against its unit's DECLARED
 * `FeatureCriterion[]` with an INDEPENDENT judge lineage (never the executor grading its own work).
 * "skipped" ⇐ no declared criteria (DESIGN §4, scores declared criteria only — never invents them).
 * "abstain" ⇐ the judge was unreachable/unparseable (fail-open, DESIGN §3). "veto"/"pass" ⇐ the judge
 * ran and found at least one unsatisfied / all satisfied criterion respectively (fail-closed on veto).
 * Epic 5's confidence scorer reads `agreement` as one input to the aggregate `confidence` it computes
 * separately — this record never computes that aggregate itself (DESIGN §5).
 */
export interface ValidationRecord {
	verdict: "pass" | "veto" | "abstain" | "skipped";
	/** 0..1 fraction of declared criteria the judge marked satisfied. */
	agreement: number;
	/** 0..1 the judge's own confidence in its verdict. */
	confidence: number;
	perCriterion: { id: string; satisfied: boolean; note?: string }[];
	/** Short overall rationale; truncated to ~600 chars. */
	rationale: string;
	/** The judge lineage that ran (e.g. "opus"), independent of the executor's model. */
	model?: string;
	/** Cross-lineage review (plans/cross-lineage-review/): the VENDOR lineage of the change's author
	 *  and of the judge. `sameLineage` is true when they share a vendor (correlated blind spots → a
	 *  weaker signal, downgraded in confidence + surfaced in the UI). `undefined` = one side's lineage
	 *  was unreadable — we never assert same-lineage we can't substantiate. */
	authorLineage?: ModelLineage;
	reviewerLineage?: ModelLineage;
	sameLineage?: boolean;
	ranAt: number;
}

/**
 * Epic 7 (convergence loop) — the disk-persisted boundary object between the TS state machine
 * (writer, `src/convergence.ts`) and the bash Stop hook (reader, `scripts/continue-loop.sh`).
 * `gap` is computed from the INDEPENDENT validator (`ValidationRecord`/`hasProof`), never raw
 * STATUS — see `plans/meta-autonomous-fleet/epic-7-convergence-loop/DESIGN.md` §1/§3.
 */
export interface VerifiedState {
	/** Meta-goal identifier (e.g. a plan dir like "plans/demo"). */
	goalId: string;
	/** 0-based cycle count. */
	iteration: number;
	/** Unmet-criteria count/score from the independent validator; 0 = done. */
	gap: number;
	/** Convergence threshold; the loop continues only while `gap > epsilon`. */
	epsilon: number;
	/** A low-confidence proposal is waiting on a human — the loop must STOP, never grind. */
	pendingEscalation: boolean;
	/** Turns (or token-proxy) consumed vs. the hard cap. */
	budget: { spent: number; cap: number };
	decision: "continue" | "converged" | "escalate" | "budget-exhausted";
	/** Epoch ms. */
	updatedAt: number;
}

export interface FeatureDecision {
	id: string;
	text: string;
	source?: "plan" | "human" | "agent";
	createdAt?: number;
	/** Provenance backlink for agent-CAPTURED decisions (source:"agent") — the run that recorded it.
	 *  Populated only on the agent path; never fabricated for plan/human sources (mirrors the
	 *  "never-faked timestamp" discipline in fabric-search.ts). */
	sourceRef?: { agentId?: string; runId?: string };
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

export interface FeatureProofAggregate {
	fresh: number;
	failed: number;
	stale: number;
	none: number;
	latestRanAt?: number;
	artifacts: number;
}

export type FeatureReadinessState = "no-candidate" | "needs-proof" | "proof-failed" | "proof-stale" | "blocked-input" | "diverged" | "uncommitted" | "ready" | "landed" | "done";

export interface FeatureReadiness {
	/** True only when landable branches are cleanly landable and freshly proved. */
	ready: boolean;
	state: FeatureReadinessState;
	/** Short machine-readable blocker codes for filtering and disabled-button reasons. */
	blockers: string[];
	/** One operator-facing next step. */
	nextAction: string;
}

export type PlanRevisionCandidateState = "candidate" | "accepted" | "rejected" | "superseded";

export interface PlanRevisionCandidate {
	id: string;
	featureId: string;
	repo: string;
	planPath: string;
	producerAgentId?: string;
	runId?: string;
	traceId?: string;
	summary: string;
	diffRef?: string;
	state: PlanRevisionCandidateState;
	reason?: string;
	reviewer?: string;
	createdAt: number;
	updatedAt: number;
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
	proof?: FeatureProofAggregate;
	planRevisionCandidates?: PlanRevisionCandidate[];
}

export interface PlanAnnotationTarget {
	planPath: string;
	lineStart?: number;
	lineEnd?: number;
	quote?: string;
	/** Anchors the annotation to a specific rendered plan block (data-block-id). */
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
	annotation?: PlanAnnotationTarget;
	resolvedAt?: number;
}


/**
 * An MCP server a profile attaches so its unit gets real, specialized capability (design tools,
 * code-analysis tools, …), beyond persona text — the thing that makes profiles genuinely different at
 * a task class. Injected for BOTH harness families: omp-rpc via `<worktree>/.omp/mcp.json`
 * (src/mcp-config.ts's `writeMcpConfig`), ACP via `session/new`'s `mcpServers` (src/acp-agent-driver.ts,
 * translated by `toAcpMcpServers`).
 *
 * SECURITY: a `stdio` server is `{command, args}` = arbitrary code execution — the SAME RCE class as
 * `AgentProfile.bin`. A REPO-sourced profile's `mcp` field is REJECTED ENTIRELY by parseProfiles
 * (agent-profiles.ts), never merged by name, never partially trusted — only env/operator profiles
 * (`OMP_SQUAD_PROFILES`) or a direct `CreateAgentOptions.mcp` (same trust tier as `opts.bin`) may set it.
 */
export interface McpServerSpec {
	name: string;
	type: "stdio" | "sse" | "http";
	/** stdio only: argv[0]. SECURITY: flows unchecked to `Bun.spawn`/the ACP child — same class as `AgentProfile.bin`. */
	command?: string;
	/** stdio only. */
	args?: string[];
	/** stdio only. */
	env?: Record<string, string>;
	/** sse/http only: the server's endpoint. */
	url?: string;
	/** sse/http only. */
	headers?: Record<string, string>;
	/** Default true. */
	enabled?: boolean;
}

export interface AgentProfile {
	id: string;
	name: string;
	description?: string;
	/** VESTIGIAL — superseded by `harness` below (this field never selected a driver; it only ever
	 *  chose flue-service/workflow vs the default omp-operator `kind`). Kept for back-compat. */
	runtime: AgentKind;
	/** Coding-agent harness this profile selects (registry key: omp/pi/claude-code/codex/opencode/gemini/…).
	 *  A REPO-sourced profile (`.glance/profiles.json`) may only name a *verified* registered harness —
	 *  parseProfiles rejects anything else and logs why. Env profiles (`OMP_SQUAD_PROFILES`) keep full trust. */
	harness?: string;
	/** Per-agent binary (argv[0]) override for the resolved harness. SECURITY: flows unchecked to
	 *  `Bun.spawn` — a REPO-sourced profile can never set this (parseProfiles drops it + warns); only an
	 *  env profile may. */
	bin?: string;
	/** MCP servers this profile attaches for real, specialized capability. SECURITY: a REPO-sourced
	 *  profile can never set this (parseProfiles drops it + warns, same RCE class as `bin`); only an
	 *  env profile may. */
	mcp?: McpServerSpec[];
	model?: string;
	/** Reasoning-effort level this profile requests. Rejected loudly at create() if the resolved harness's
	 *  `capabilities.thinking` is `false` (no thinking-level channel) rather than silently dropped. */
	thinking?: ThinkingLevel;
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
	/** Which coding-agent harness backs this unit (omp/pi/claude-code/…) — for trust legibility so a
	 *  surface never renders, e.g., "always-ask" over a harness that can't ask. Absent ⇒ "omp". */
	harness?: string;
	/** Harness capability summary surfaced for the UI (approval channel + restart survival). */
	harnessCaps?: { toolApproval: "native" | "none" | "preauth-allowlist"; resumable: boolean; hostTools: boolean; contextInjection: "native" | "none" | "mcp" };
	/** NAMES ONLY of the MCP servers resolved for this unit (`McpServerSpec.name`) — deliberately never
	 *  the full spec, so `command`/`env`/`url`/`headers` (secrets/exec) never reach a surface. Absent ⇒
	 *  no MCP servers attached. */
	mcpServerNames?: string[];
	/** Specialization of this unit ("tester" writes the test first, "observer" reproduces a
	 *  regression), orthogonal to `kind`. Absent = general coder (today's default). */
	executionRole?: ExecutionRole;
	/** Parent workflow agent id, when this agent is a spawned fan-out branch. */
	parentId?: string;
	/** The node in the PARENT's workflow graph this branch executes (structural lineage — not a display
	 *  string; distinct from `name`, which is mutable and identical across parallel siblings of one node). */
	parentNodeId?: string;
	/** Distinguishes same-node siblings (parallel fan-out) and cold-resume re-spawns of the same node. */
	branchIndex?: number;
	/** Persisted subagent tree snapshot (task-spawned children), carried opaquely through restore paths.
	 *  Concern 02 owns the merge/dirty/flush semantics that populate and reconcile this on a live agent. */
	subagents?: SubagentNode[];
	/** Static workflow graph topology, captured once per run. Concern 03 owns emission (workflow.graph
	 *  journal event) and the consuming switch case; this field is pure plumbing until then. */
	workflowGraph?: WorkflowGraphSnapshot;
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
	/** The live/last run's trace id (RunAccumulator's `SpanCollector.id`) — the SAME id-space
	 *  `RunReceipt.traceId`/`GET /api/trace/:id` use (`feat:<featureId>` or `run:<agentId>:<runId>` where
	 *  `runId` is the RECEIPT run id `Date.now().toString(36)`, not the workflow engine's own `runId`
	 *  format). Set alongside `receipt` at the same two sites (turn-progress + finalizeRun) so the two
	 *  never drift apart. Absent until a run has actually started. */
	traceId?: string;
	/** Compact live RPC session metadata for Control Tower parity with the TUI. */
	session?: AgentSessionSummary;
	/** Current todo phases from the backing harness, preserved for rich web rendering. */
	todoPhases?: RpcSessionState["todoPhases"];
	/** Pending human-input requests (status === "input" when non-empty). */
	pending: PendingRequest[];
	/** Non-blocking "I'm unsure, here's a proposal" notes the agent raised via `squad_report` (Epic 5
	 *  DESIGN §D2). Deliberately NOT a `PendingRequest` — `pending.length` is load-bearing for
	 *  `blockedReason`/`effectiveAutonomyMode`'s observe cap, and a report must never block the agent.
	 *  Live/run-scoped only (not persisted to state.json), append-only across a run. */
	reports?: AgentReport[];
	/** Last 5 SIGNIFICANT lifecycle transitions (turn-progress excluded) — a compact inline strip.
	 *  Full history via GET /api/agents/:id/transitions. Capped deliberately: this rides emitAgent's
	 *  broadcast (per RPC-frame on the hot path), so it must never carry the full ring. */
	transitions?: TransitionEntry[];
	/** Count of error-class transitions (to:"error", reason "fail"|"catastrophe"|"exit-error") in the
	 *  trailing 1h, computed over the FULL ring server-side — NOT derived from `transitions` above,
	 *  which is capped and would undercount a busy/flapping agent. Feeds insights.ts hotspot ranking. */
	errorTransitions1h?: number;
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
	/** Repo-relative path prefixes this agent will read. */
	requires?: string[];
	/** Repo-relative path prefixes this agent owns — legacy shorthand for produced writes. */
	owns?: string[];
	/** Repo-relative path prefixes this agent will write/create. Defaults to `owns`. */
	produces?: string[];
	/** Whether the scope contract came from an operator or planner inference. */
	scopeSource?: ScopeSource;
	/** Workflow definition backing this agent, when kind === "workflow". */
	workflow?: WorkflowMemberConfig;
	/** Live workflow checkpoint/rollup, emitted on every stage boundary. */
	workflowState?: WorkflowRunState;
	/** Derived from `workflowState.terminal` (present and not yet superseded by a fork) — survives a
	 *  restart because it's recomputed from the persisted marker rather than tracked independently. Gates
	 *  the webapp's "Fork from step N" control; an old daemon that never sets this field hides the button
	 *  instead of showing one that 404s. */
	forkAvailable?: boolean;
	/** Requested authority persisted for this run; effectiveMode is capped by daemon policy and blockers. */
	autonomyMode?: AutonomyMode;
	/** Actual authority after approval/env caps and blockers. */
	effectiveMode?: AutonomyMode;
	/** Current proof freshness summary for this agent's worktree. */
	verificationState?: VerificationState;
	/** Stable proof reference/fingerprint for display and audit correlation. */
	proof?: { commit?: string; command?: string; ranAt?: number; fingerprint?: string };
	/** Epic 3 independent-validator verdict for this agent's most recent land attempt (DESIGN §5) —
	 *  the input Epic 5's confidence scorer reads via `validation.agreement`. Absent until a land
	 *  attempt has run the validator gate. */
	validation?: ValidationRecord;
	/** Why authority is currently capped to observe. */
	blockedReason?: string;
	/** Actions this surface may offer for the current effective mode. */
	availableActions?: AgentAction[];
	/** Run-end self-confidence 0..1, stamped by `scoreConfidence` (src/confidence.ts) at `finalizeRun`.
	 *  Absent until a run has actually finished. Below `OMP_SQUAD_CONFIDENCE_FLOOR` caps
	 *  `effectiveAutonomyMode` to `assist` (propose-only) — see autonomy.ts. */
	confidence?: number;
	/** Verified by the auto-land loop in confirm mode; awaiting a one-tap Land. */
	landReady?: boolean;
	/** PR-mode landing metadata (concern 06), set at push/merge time. Absent in local mode. */
	prUrl?: string;
	prNumber?: number;
	prState?: "draft" | "open" | "merged" | "closed";
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
	/** Fine-grained run spans. The structural spine (kind !== "tool") is always present on a finalized
	 *  receipt (D1); only `tool` spans are tail-sampled. Receipt rollups above are never sampled. */
	spans?: Span[];
	/** True when tool-level spans were tail-sampled out; the structural spine is still present. An
	 *  honest "tool detail sampled" signal distinct from `TraceResponse.partial` ("spine missing"). */
	sampled?: boolean;
	/** Feature/parent ids copied onto receipts so trace trees survive agent removal. */
	featureId?: string;
	parentId?: string;
	/** Which harness drove the run ("omp" for daemon-spawned; external ingests set their own). */
	harness?: string;
	/** Epic 3 independent-validator verdict for this run's land attempt, copied from `AgentDTO.validation`
	 *  at finalize time so it survives the run durably (Epic 5's confidence input, DESIGN §5). */
	validation?: ValidationRecord;
	/** Run-end self-confidence 0..1 (src/confidence.ts); absent until computed. */
	confidence?: number;
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

/** Provenance for scope contracts. Operator-declared scopes are enforceable; inferred scopes are advisory until promoted. */
export type ScopeSource = "inferred" | "operator";

/** Persisted across restarts in `<stateDir>/state.json`. */
export interface PersistedAgent {
	id: string;
	name: string;
	repo: string;
	worktree: string;
	branch?: string;
	model?: string;
	profileId?: string;
	approvalMode: ApprovalMode;
	autonomyMode?: AutonomyMode;
	/** Initial task prompt, if the agent was created with one. */
	task?: string;
	/** Extra system-prompt text appended for specialized surfaces, e.g. console chat. */
	appendSystemPrompt?: string;
	thinking?: ThinkingLevel;
	issue?: IssueRef;
	featureId?: string;
	/** Runtime class; defaults to "omp-operator" when absent (back-compat). */
	kind?: AgentKind;
	/** Specialization of this unit ("tester" writes the test first, "observer" reproduces a
	 *  regression), orthogonal to `kind`. Absent = general coder (today's default). */
	executionRole?: ExecutionRole;
	/** DEPRECATED — superseded by `harness`. Legacy on-disk records carry "omp"|"acp"; the manager
	 *  normalizes it to a harness name at the single makeDriver choke point (runtimeToHarness). */
	runtime?: "omp" | "acp";
	/** Coding-agent harness backing this unit (registry key: omp/pi/claude-code/codex/opencode/gemini/…).
	 *  Absent ⇒ resolved from GLANCE_HARNESS then "omp". Supersedes `runtime`. */
	harness?: string;
	/** Per-agent binary (argv[0]) override for the resolved harness (else the descriptor's bin, or
	 *  GLANCE_BIN for the default harness). */
	bin?: string;
	/** MCP servers resolved for this unit (opts.mcp ?? profile.mcp — see squad-manager.ts createWithId).
	 *  Injected into the worktree's `.omp/mcp.json` (omp-rpc harnesses) or the ACP `session/new` call at
	 *  spawn time; never re-derived on restore. */
	mcp?: McpServerSpec[];
	/** flue-service only: worker invocation config. */
	flue?: FlueMemberConfig;
	/** workflow only: graph file backing this run. */
	workflow?: WorkflowMemberConfig;
	/** workflow only: resumable run position, persisted so a daemon restart can continue the graph. */
	workflowState?: WorkflowRunState;
	/** Parent workflow agent id, when this is a spawned fan-out branch. */
	parentId?: string;
	/** The node in the PARENT's workflow graph this branch executes (structural lineage — not a display
	 *  string; distinct from `name`, which is mutable and identical across parallel siblings of one node). */
	parentNodeId?: string;
	/** Distinguishes same-node siblings (parallel fan-out) and cold-resume re-spawns of the same node. */
	branchIndex?: number;
	/** Persisted subagent tree snapshot (task-spawned children), carried opaquely through restore paths.
	 *  Concern 02 owns the merge/dirty/flush semantics that populate and reconcile this on a live agent. */
	subagents?: SubagentNode[];
	/** Static workflow graph topology, captured once per run. Concern 03 owns emission (workflow.graph
	 *  journal event) and the consuming switch case; this field is pure plumbing until then. */
	workflowGraph?: WorkflowGraphSnapshot;
	/** When set, run this agent inside a container instead of locally. */
	sandbox?: SandboxConfig;
	/** Repo-relative path prefixes this agent reads — restored so read/write hazards survive a restart. */
	requires?: string[];
	/** Repo-relative path prefixes this agent owns — restored so partition survives a restart. */
	owns?: string[];
	/** Repo-relative path prefixes this agent writes/creates. Defaults to `owns`. */
	produces?: string[];
	/** Whether the scope contract came from an operator or planner inference. */
	scopeSource?: ScopeSource;
	/** Snapshot of in-flight human-input requests at persist time. Advisory only — see squad-manager.ts's
	 *  cold-adopt path, which consumes this ONLY to record a pending-orphaned close, never to re-populate
	 *  dto.pending. A cold-adopted agent's correlation id is dead (the RPC waiter died with the old process),
	 *  so nothing restored here can ever be legitimately answered — do not build an "answerable restore" path. */
	pending?: PendingRequest[];
	/** Mirrors `AgentDTO.traceId` (topology review finding 7) so a restarted run's trace link survives —
	 *  without this a receipt-linked run still on disk becomes unreachable via `GET /api/trace/:id` the
	 *  moment the daemon restarts, even though nothing about the receipts themselves changed. Threaded
	 *  through every boot path via `lineageFieldsFrom`, same sticky rule as the two live-run write sites. */
	traceId?: string;
	/** The durable "what we picked" record of `routeIntake`'s decision (model-routing-control-loop
	 *  concern 03) — stamped once at create time, never mutated after. `mode` is the resolved verify
	 *  mode ("tdd"/"verify"/"none", or whatever the router or an explicit `opts.verify` settled on);
	 *  `tier` is `tierOf(thinking)` (model-outcomes.ts), the same coarse bucketing the model-outcome
	 *  ledger already uses, so a later join (task-outcomes.ts) groups on identical axes. Additive/
	 *  optional: absent on any agent persisted before this field existed. */
	routing?: { mode: string; tier: string; thinking?: ThinkingLevel; routedAt: number };
}

/** Persisted feature envelope — additive `features[]` in `<stateDir>/state.json`. */
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
	/** DEPRECATED — superseded by `harness` (kept for back-compat / legacy callers). */
	runtime?: "omp" | "acp";
	/** Coding-agent harness to run this unit on (registry key: omp/pi/claude-code/codex/opencode/gemini/…).
	 *  Absent ⇒ GLANCE_HARNESS then "omp". */
	harness?: string;
	/** Per-agent binary (argv[0]) override for the resolved harness. */
	bin?: string;
	/** MCP servers to attach to this unit (real, specialized capability — beyond persona text). Explicit
	 *  `opts.mcp` wins over `profile.mcp` (same `opts ?? profile` ordering as `harness`/`bin`). Same trust
	 *  tier as `opts.bin` — sanitization only applies to a REPO-sourced *profile*'s `mcp` field, never to
	 *  this direct option. */
	mcp?: McpServerSpec[];
	/** Branch to create/checkout for the worktree. Defaults to a unique `squad/<agent-id>` branch. */
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
	/** Selects the synthesized loop variant for `verify` (tester/observer roles). Default "verify". */
	verifyMode?: "verify" | "tdd" | "observe";
	/** Specialization of this unit ("tester" writes the test first, "observer" reproduces a
	 *  regression), orthogonal to `kind`. Absent = general coder (today's default). */
	executionRole?: ExecutionRole;
	autonomyMode?: AutonomyMode;
	/** Parent workflow agent id, when spawning a fan-out branch. */
	parentId?: string;
	/** The node in the PARENT's workflow graph this branch executes (structural lineage — not a display
	 *  string; distinct from `name`, which is mutable and identical across parallel siblings of one node). */
	parentNodeId?: string;
	/** Distinguishes same-node siblings (parallel fan-out) and cold-resume re-spawns of the same node. */
	branchIndex?: number;
	/** Persisted subagent tree snapshot (task-spawned children), carried opaquely through restore paths.
	 *  Concern 02 owns the merge/dirty/flush semantics that populate and reconcile this on a live agent. */
	subagents?: SubagentNode[];
	/** Static workflow graph topology, captured once per run. Concern 03 owns emission (workflow.graph
	 *  journal event) and the consuming switch case; this field is pure plumbing until then. */
	workflowGraph?: WorkflowGraphSnapshot;
	/** Run this agent inside a container (sandboxed execution); mounts the worktree by default. */
	sandbox?: SandboxConfig;
	/** Auto-pick a process (verify / plan-approve / fan-out) from the task. Default on; false = plain agent. */
	autoRoute?: boolean;
	/** Repo-relative path prefixes this agent will read; conflicts with live agents' owns/produces. */
	requires?: string[];
	/** Repo-relative path prefixes this agent will edit. A spawn whose paths overlap a live agent's writes is refused. */
	owns?: string[];
	/** Repo-relative path prefixes this agent will write/create. Defaults to `owns`. */
	produces?: string[];
	/** Whether the scope contract came from an operator or planner inference. */
	scopeSource?: ScopeSource;
	/** Auto-create + attach a tracking Plane issue for this spawn (work→Plane). Set at human/dispatch spawn entry points; off for restore/fan-out. */
	track?: boolean;
	/** Skip the global live-agent WIP cap (restore / fan-out paths that recreate already-accounted-for agents). */
	bypassCap?: boolean;
	/** Re-created from a surviving worktree during restart adoption (OMPSQ-164). Marks the agent so the
	 *  orchestrator auto-lands its already-complete work directly, since the event-driven auto-land that
	 *  fires on a run-to-completion never re-fires for an adopted agent that doesn't re-run. */
	adopted?: boolean;
	/** Resuming a workflow run on a FRESH inner thread (the adopt path — the prior host is gone), so the
	 *  in-flight graph node must re-execute and re-prime the goal rather than wait on a turn no thread is
	 *  running. The warm reconnect path leaves this false. */
	cold?: boolean;
	/** Carries a persisted run's trace link through the adopt/restore boot paths (topology review finding
	 *  7) — absent on a genuinely fresh create(), which only ever assigns this once a run actually starts. */
	traceId?: string;
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
	/** Which synthesized loop to build. Default "verify". */
	mode?: "verify" | "tdd" | "observe";
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
	| { type: "automation"; event: AutomationEvent }
	| { type: "transition"; entry: TransitionEntry };

/** The daemon's periodic background loops — the ones that run without an operator and were, until the
 *  automation log, invisible. Scout reads agent reasoning; Sentinel (plans/sentinel-drift-probe, v0
 *  default-off) rides the SAME reasoning read for a second, cheap drift classification, but reports
 *  on its OWN "sentinel" channel so its LLM spend/finds never inflate Scout's backlog numbers; Observer
 *  and Opportunity run pure/zero-token checks; Dispatcher polls Plane and spawns routed agents. */
// "scope" is event-driven (scope-contract audit findings), not a periodic loop like the others.
export type AutomationLoop = "scout" | "observer" | "opportunity" | "dispatch" | "scope" | "plan-sync" | "resident-planner" | "sentinel";

/**
 * Structured reason an automation loop intentionally skipped a unit without doing work.
 * Proves a loop is alive-but-idle (not dead) and categorizes WHY so the UI can rank
 * "at capacity" above "nothing to do". Pair with `detail` for the human-readable specifics.
 */
export type AutomationSkipReason =
	| "budget" //          LLM/token budget for the window is spent
	| "overlap" //         a previous tick of this loop is still running
	| "wip-cap" //         concurrency / global WIP ceiling reached
	| "idle" //            nothing to act on this tick (no candidates/findings)
	| "already-handled" // all candidates already claimed / filed / deduped
	| "human-review" //    work exists but is gated on human review / do-not-auto-land
	| "blocked" //         work exists but is blocked by open dependency issues
	| "already-done"; //   open issue's work is already recorded done in the repo (closed plan concern)

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
	/** Structured reason this unit intentionally skipped work; skip events persist even with zero work/cost. */
	skipReason?: AutomationSkipReason;
	/** Severity of the unit; "warn"/"error" force the event onto disk even with no work done. */
	level?: "info" | "warn" | "error";
	/** Optional human-readable detail (a filed title, an error message, or the specifics behind a skipReason). */
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
	| { type: "prompt"; id: string; message: string; clientTurnId?: string; displayText?: string }
	| { type: "set-model"; id: string; model: string }
	| { type: "answer"; id: string; requestId: string; value: string }
	| { type: "interrupt"; id: string }
	| { type: "kill"; id: string }
	| { type: "restart"; id: string }
	| { type: "fork"; id: string; seq?: number }
	| { type: "remove"; id: string; deleteWorktree?: boolean }
	| { type: "create"; options: CreateAgentOptions }
	| { type: "message"; to: string; text: string }
	| { type: "snapshot" } // request a full roster + recent transcript replay
	| { type: "subscribe"; id: string } // ask for transcript replay of one agent
	| { type: "commission"; spec: CommissionSpec }
	| { type: "set-mode"; id: string; mode: AutonomyMode; reason?: string };

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
