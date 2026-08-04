/**
 * The shared kernel (deepen 06, final slice) - the vocabulary every lane speaks: actor identity
 * and RBAC tier, the agent lifecycle state, the transcript grammar every surface renders, the
 * human-input request shape, and the work-item reference agents advance. These types have no
 * dependency on any lane (the single import below is the lane-owned WorkLane, referenced by
 * IssueRef's clamp-rule field) and everything depends on them - which is exactly the deletion
 * test for a kernel: removing this file breaks every lane; removing any lane leaves it intact.
 * types.ts re-exports all of these, so existing importers keep compiling; new code should
 * import from here.
 */
import type { WorkLane } from "./lane.ts";

/** Derived, human-meaningful lifecycle state of one managed agent. */
export type AgentStatus =
	| "starting" // process spawned, awaiting the RPC `ready` frame
	| "working" // an agent turn is actively streaming
	| "idle" // ready, turn finished, awaiting the next instruction
	| "input" // BLOCKED on a human decision (approval / question / tool input)
	| "error" // spawn failed, child crashed, or fatal RPC error
	| "stopped"; // intentionally terminated

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

export interface TranscriptEvent {
	/**
	 * Open event taxonomy for manager-authored proof facts.
	 * HAZARD: this is NOT `TranscriptEntry.kind`; entry.kind is the closed render/source axis
	 * ("user" | "assistant" | "thinking" | "tool" | "system"), while event.kind is an open,
	 * feature-owned fact taxonomy ("gate-verdict", "land-attempt", ...).
	 */
	kind: string;
	/**
	 * Attesting authority for this fact. Stamped by the emitting chokepoint
	 * (emitUnitTranscriptEvent / ChannelStore.appendManager), never accepted from
	 * client or caller input. Entries persisted before provenance landed lack it and
	 * read as "manager" (EVENT_ISSUER_MANAGER — the only issuer today).
	 */
	issuer?: string;
	payload: unknown;
}


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
	/**
	 * Optional typed proof event attached to this transcript line.
	 * HAZARD: `TranscriptEntry.kind` and `event.kind` are different axes: entry.kind stays
	 * the closed transcript/source axis; event.kind is an open manager-authored fact taxonomy.
	 */
	event?: TranscriptEvent;
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
	/** The authored spec body (Tier-2 / plan-concern text) for context injection at dispatch. Populated
	 *  best-effort from the issue detail; UNTRUSTED (human/skills-MCP-writable) — must be fenced as data,
	 *  not instructions, before it reaches an agent prompt. Absent ⇒ title-only dispatch (no regression). */
	description?: string;
	/** Work lane resolved from a Plane `lane:hotfix|feature|chore` LABEL (never title text — titles are
	 *  LLM-writable, a fail-open privilege key; labels are human-set). Set by `src/squad-manager.ts`'s
	 *  `dispatchSpec` from the issue detail fetch. A lane sourced here is ticket text and, per the clamp
	 *  rule (adw-factory-borrows concern 02, DESIGN.md), may only move policy axes in shadow or the
	 *  stricter direction — never on its own escalate a privilege axis (model apply-mode, ceiling raise). */
	lane?: WorkLane;
}

/** Provenance for scope contracts. Operator-declared scopes are enforceable; inferred scopes are advisory until promoted. */
export type ScopeSource = "inferred" | "operator";

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
