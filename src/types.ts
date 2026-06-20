/**
 * Shared domain + wire types for omp-squad.
 *
 * The SquadManager owns the authoritative in-memory roster (AgentRecord).
 * Surfaces (TUI, web) consume serializable snapshots (AgentDTO) and the
 * SquadEvent stream, and send ClientCommand back.
 */

import type { RpcExtensionUIRequest, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

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
 */
export type AgentKind = "omp-operator" | "flue-service";

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

/** Serializable per-agent snapshot sent to surfaces. */
export interface AgentDTO {
	id: string;
	name: string;
	status: AgentStatus;
	/** Which runtime backs this agent. */
	kind: AgentKind;
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
	/** Runtime class; defaults to "omp-operator" when absent (back-compat). */
	kind?: AgentKind;
	/** flue-service only: worker invocation config. */
	flue?: FlueMemberConfig;
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
	name: "lint" | "typecheck" | "acceptance";
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

// ── Manager → surface events ────────────────────────────────────────────────

export type SquadEvent =
	| { type: "roster"; agents: AgentDTO[] }
	| { type: "agent"; agent: AgentDTO }
	| { type: "removed"; id: string }
	| { type: "transcript"; id: string; entry: TranscriptEntry }
	| { type: "log"; level: "info" | "warn" | "error"; text: string };

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
