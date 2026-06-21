/**
 * Shared domain + wire types for omp-squad.
 *
 * The SquadManager owns the authoritative in-memory roster (AgentRecord).
 * Surfaces (TUI, web) consume serializable snapshots (AgentDTO) and the
 * SquadEvent stream, and send ClientCommand back.
 */

import type { RpcExtensionUIRequest, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { WorkflowRunState } from "./workflow/types.ts";

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

export interface TranscriptEntry {
	kind: TranscriptKind;
	text: string;
	ts: number;
}

/** A work item (e.g. a Plane issue) an agent is advancing. */
export interface IssueRef {
	/** Provider issue id. */
	id: string;
	/** Human identifier, e.g. "DAGON-263". */
	identifier?: string;
	name: string;
	state?: string;
	url?: string;
	/** Provider project id this issue belongs to. */
	projectId?: string;
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
}

/**
 * A Feature — a cross-cutting unit of work spanning a plan dir and/or a set of agents/worktrees.
 * Phase 1: fully DERIVED at read time (no persistence) from plan dirs + the roster + live git.
 */
export interface FeatureDTO {
	/** Stable derived id: `plan:<repo>:<dir>` or `agent:<agentId>`. */
	id: string;
	title: string;
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
	/** Repo root the worktree was cut from. */
	repo: string;
	/** Absolute path of this agent's git worktree (its cwd). */
	worktree: string;
	branch?: string;
	model?: string;
	approvalMode: ApprovalMode;
	/** One-line description of what it's doing right now (tool name / activity). */
	activity?: string;
	/** Latest todo summary "done/total" + active task text. */
	todo?: { done: number; total: number; active?: string };
	/** Context window usage 0..1. */
	contextPct?: number;
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
	approvalMode: ApprovalMode;
	/** Initial task prompt, if the agent was created with one. */
	task?: string;
	thinking?: ThinkingLevel;
	issue?: IssueRef;
	featureId?: string;
	/** Runtime class; defaults to "omp-operator" when absent (back-compat). */
	kind?: AgentKind;
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
	/** Snapshot of member branches so land status survives an agent being killed. */
	branches?: { branch?: string; worktree: string; agentId?: string }[];
	createdAt: number;
	updatedAt: number;
	archived?: boolean;
	/** When Fabro-driven: the research-plan-implement workflow agent running this feature. */
	workflowAgentId?: string;
}

/** Options when adding an agent to the squad. */
export interface CreateAgentOptions {
	name?: string;
	repo: string;
	/** Branch to create/checkout for the worktree. Defaults to `squad/<name>`. */
	branch?: string;
	/** Reuse an existing path as the cwd instead of cutting a worktree. */
	existingPath?: string;
	model?: string;
	approvalMode?: ApprovalMode;
	/** Prompt to send immediately once the agent is ready. */
	task?: string;
	/** Reasoning effort for this agent (defaults to "low" so fleet agents stay responsive). */
	thinking?: ThinkingLevel;
	/** Work item to advance (shown in the command center; e.g. a Plane issue). */
	issue?: IssueRef;
	/** Feature to attach this agent to on creation. */
	featureId?: string;
	/** Path to a workflow graph (`.fabro`) to run as the agent's process; `task` becomes the goal. */
	workflow?: string;
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
	| { type: "roster"; agents: AgentDTO[] }
	| { type: "agent"; agent: AgentDTO }
	| { type: "removed"; id: string }
	| { type: "transcript"; id: string; entry: TranscriptEntry }
	| { type: "log"; level: "info" | "warn" | "error"; text: string }
	| { type: "commands"; id: string; commands: CommandInfo[] }
	| { type: "features-changed" };

// ── Surface → manager commands ──────────────────────────────────────────────

export type ClientCommand =
	| { type: "prompt"; id: string; message: string }
	| { type: "answer"; id: string; requestId: string; value: string }
	| { type: "interrupt"; id: string }
	| { type: "kill"; id: string }
	| { type: "restart"; id: string }
	| { type: "remove"; id: string; deleteWorktree?: boolean }
	| { type: "create"; options: CreateAgentOptions }
	| { type: "snapshot" } // request a full roster + recent transcript replay
	| { type: "subscribe"; id: string } // ask for transcript replay of one agent
	| { type: "commission"; spec: CommissionSpec };

// ── Federation (Phase 2): cross-operator coordination ───────────────────────

/** Availability of a human operator, used for delegation / away-mode auto-grant. */
export type Availability = "active" | "away" | "offline";

/** Verified actor that issued a command (identity from the federation transport). */
export interface Actor {
	/** Stable id, e.g. tailnet login "bob@company.com" or "local". */
	id: string;
	displayName?: string;
	/** "local" for same-machine surfaces, "remote" for federation peers. */
	origin: "local" | "remote";
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
