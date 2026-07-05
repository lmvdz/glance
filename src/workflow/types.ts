/**
 * Workflow runtime — domain model.
 *
 * A workflow is a directed graph (authored in a Graphviz/DOT subset, the same
 * dialect fabro uses) that drives ONE goal through gated, looping, multi-stage
 * work. The engine (engine.ts) walks this graph; how each node actually runs is
 * delegated to a `NodeExecutor` (executor.ts), so the same engine can drive one
 * persistent agent today and fan out across the fleet later.
 *
 *   node   = a step authored in the graph
 *   stage  = one runtime execution of a node (a looping node yields many stages)
 */

/** Node behaviour, derived from the DOT `shape` attribute. */
export type NodeKind =
	| "start" // Mdiamond — entry; exactly one
	| "exit" // Msquare — terminal; exactly one
	| "agent" // box / default — an agentic turn with tools
	| "prompt" // tab — a single reasoning turn (Phase A: executed like an agent turn)
	| "command" // parallelogram — run a shell script, outcome from exit code
	| "human" // hexagon — pause for a human to choose an outgoing edge
	| "conditional" // diamond — pure routing, no execution
	| "parallel" // component — fan-out (parsed; not executed in Phase A)
	| "merge" // tripleoctagon — fan-in (parsed; not executed in Phase A)
	| "wait"; // insulator — delay (parsed; not executed in Phase A)

/** A node authored in the graph. */
export interface WorkflowNode {
	id: string;
	kind: NodeKind;
	label?: string;
	/** agent / prompt: task instructions. `@path.md` is resolved relative to the workflow dir. */
	prompt?: string;
	/** command: the shell script to run. */
	script?: string;
	/** Per-node model override (consumed by the executor). */
	model?: string;
	reasoningEffort?: string;
	/** The run fails if this node never succeeds. */
	goalGate?: boolean;
	/** On failure with no matching edge, route here. */
	retryTarget?: string;
	/** Max executions of this node in one run (overrides the graph default). */
	maxVisits?: number;
	/** On visit-cap exhaustion, route here instead of hard-failing (e.g. fix-up → escalate). */
	overflow?: string;
	/**
	 * Run this agent node on a SEPARATE agent/context from the shared inner thread — a distinct lineage.
	 * Set on the TDD `write-test` author so the test author and the implementer cannot co-reason: the
	 * implementer inherits only the on-disk red test, never the author's conversation (defeating the
	 * "coder grades its own homework" failure the TDD role exists to prevent). The isolated agent can also
	 * carry a distinct (stronger) model. Only meaningful for `agent`/`prompt` nodes.
	 */
	isolatedLineage?: boolean;
	/** All raw DOT attributes, for forward-compatibility. */
	attrs: Record<string, string>;
}

/** A directed edge with optional human-gate label and routing condition. */
export interface WorkflowEdge {
	from: string;
	to: string;
	/** Display / human-gate option (e.g. "[A] Approve"). */
	label?: string;
	/** Routing predicate, e.g. `outcome=succeeded` or `outcome=failed || preferred_label=Continue`. */
	condition?: string;
}

/** A parsed workflow graph. */
export interface Workflow {
	name: string;
	goal?: string;
	/** Default per-node visit cap when a node sets none. */
	maxNodeVisits?: number;
	/** Raw CSS-like model stylesheet (graph attr `model_stylesheet`), resolved per node by the executor. */
	modelStylesheet?: string;
	nodes: Map<string, WorkflowNode>;
	edges: WorkflowEdge[];
	/** Resolved start node id. */
	start: string;
	/** Resolved exit node id. */
	exit: string;
}

/** Outcome of executing a single node. */
export type Outcome = "succeeded" | "failed";

/** What an executor returns after running a node. */
export interface NodeResult {
	outcome: Outcome;
	/** Human-readable output, fed forward as context. */
	text?: string;
	/**
	 * Set by a branch executor to mean "this branch never genuinely ran" — a ceiling/WIP refusal, an
	 * abort teardown, or a spawn crash. Distinguishes a transient resource condition (re-spawnable on
	 * resume) from a real executed outcome (succeeded/failed) that should stick. Ignored outside runParallel.
	 */
	notAttempted?: boolean;
}

/** Mutable run state threaded through condition evaluation. */
export interface RunContext {
	goal: string;
	/** Outcome of the most recently executed node. */
	outcome?: Outcome;
	/** Label chosen at the most recent human gate (`preferred_label` in conditions). */
	preferredLabel?: string;
	/** Free-form variables addressable as `context.<name>` in conditions. */
	vars: Record<string, string>;
}

export type WorkflowAutonomyMode = "manual" | "supervised" | "autonomous";

export interface WorkflowProofState {
	state: "none" | "failed" | "stale" | "fresh";
	ranAt?: number;
	artifacts: number;
}

export interface WorkflowJournalEvent {
	type:
		| "workflow.node.start"
		| "workflow.node.end"
		| "workflow.human_gate.start"
		| "workflow.human_gate.end"
		| "workflow.parallel.start"
		| "workflow.parallel.end"
		| "workflow.branch.start"
		| "workflow.branch.end"
		| "workflow.verification.start"
		| "workflow.verification.end"
		| "workflow.land.start"
		| "workflow.land.end"
		| "workflow.graph";
	at: number;
	workflow: string;
	runId: string;
	nodeId?: string;
	label?: string;
	kind?: NodeKind;
	phase?: "start" | "end";
	outcome?: Outcome;
	text?: string;
	options?: string[];
	selected?: string;
	proof?: WorkflowProofState;
	detail?: string;
	/** Present on a "workflow.graph" event: the static topology snapshot. Concern 03 emits/consumes it;
	 *  this concern only needs the union member + field to exist so its round-trip fixtures type-check. */
	graph?: WorkflowGraphSnapshot;
}

/** One node in a journaled workflow graph snapshot (mirrors WorkflowNode's renderable subset). */
export interface WorkflowGraphNode {
	id: string;
	kind: NodeKind;
	label?: string;
	maxVisits?: number;
	overflow?: string;
	goalGate?: boolean;
	retryTarget?: string;
}

/** One edge in a journaled workflow graph snapshot (mirrors WorkflowEdge). */
export interface WorkflowGraphEdge {
	from: string;
	to: string;
	label?: string;
	condition?: string;
}

/** Static topology snapshot of a workflow's DOT graph, journaled once per run so the UI can render
 *  intended structure with live progress overlaid. version:1 lets future shape changes be additive. */
export interface WorkflowGraphSnapshot {
	version: 1;
	name: string;
	nodes: WorkflowGraphNode[];
	edges: WorkflowGraphEdge[];
	start: string;
	exit: string;
	maxNodeVisits?: number;
}


/** Lifecycle notification for one stage (a single node execution). */
export interface StageEvent {
	/** 0-based execution order within the run. */
	index: number;
	nodeId: string;
	label: string;
	kind: NodeKind;
	phase: "start" | "end";
	outcome?: Outcome;
	text?: string;
}

/** Result of a whole run. */
export interface RunResult {
	outcome: Outcome;
	/** Why the run ended (success summary or failure reason). */
	reason: string;
	stages: StageEvent[];
}

/** A resumable snapshot of where a run is, captured at each node boundary. */
export interface EngineCheckpoint {
	/** The run goal (re-primed into the agent thread on resume). */
	goal: string;
	/** The node being executed (or about to) when this checkpoint was taken. */
	currentNode: string;
	/** Per-node visit counts, so fix-up loop caps survive a resume. */
	visits: Record<string, number>;
	/** Run variables threaded through routing conditions. */
	vars: Record<string, string>;
	/** Outcome of the last completed node (for routing on resume). */
	outcome?: Outcome;
	/** Label chosen at the most recent human gate. */
	preferredLabel?: string;
	/** Monotonic stage index. */
	index: number;
	/**
	 * How many times a cold (dead-thread) resume has re-entered this exact node without making
	 * forward progress. Reset to 0 by the exit checkpoint (a node that advanced), incremented only on
	 * a cold re-entry. Bounds a run that keeps crashing the daemon before it ever reaches idle — the
	 * engine visit-cap deliberately does not re-count the resumed node, so this is its only ceiling.
	 */
	resumeAttempts?: number;
	/**
	 * Set only on the transient per-branch checkpoints `runParallel` emits during a fan-out (see
	 * `branchOutcomes`); absent/false on every ordinary node-boundary checkpoint `run()` emits. Lets a
	 * listener persist branchOutcomes for the live-progress view without mistaking a mid-fan-out emission
	 * for the run's resumable position.
	 */
	transient?: boolean;
	/**
	 * Deterministic `${nodeId}#${visitIndex}:${branchIndex}` → outcome map for the parallel node currently
	 * fanning out. Emitted as a verbatim clone of that node's ENTRY checkpoint (same resumeAttempts/visits/
	 * currentNode every time) plus the full accumulated map, so a mid-fan-out emission can never reset the
	 * poison counter or leak a branch's visit increment into persisted state. Present only on `transient`
	 * emissions — the merge node's ordinary exit checkpoint carries none, self-clearing the map on join.
	 */
	branchOutcomes?: Record<string, BranchOutcome>;
}

/**
 * One parallel branch's fate for the run currently in progress. `succeeded`/`failed` are genuinely-
 * executed terminal results (including a turn that ran out its timeout budget); `not_attempted` covers
 * ceiling/WIP refusals, abort teardowns, and spawn crashes — none of which ever really ran, so a resume
 * re-spawns them under the same deterministic branch key.
 */
export interface BranchOutcome {
	disposition: "succeeded" | "failed" | "not_attempted";
	text?: string;
	at: number;
}

/** Persisted run state — an engine checkpoint plus the executor's stage rollup (for the progress view). */
export interface WorkflowRunState extends EngineCheckpoint {
	rollup: { label: string; status: "in_progress" | "completed" }[];
	runId?: string;
	/** Set on a run minted by `fork()` (concern 04): the source run/checkpoint it was forked from. Kept
	 *  runId-free-vs-branchKey style is not needed here (this identifies the fork's own lineage, not a
	 *  branch key), so it plainly carries the source runId + the checkpoint seq the fork restored from. */
	forkedFrom?: { runId: string; seq: number };
	autonomy?: WorkflowAutonomyMode;
	sessionId?: string;
	proof?: WorkflowProofState;
	/**
	 * Resume-time only (NOT persisted state): true when this run is resuming on a FRESH inner thread
	 * after the prior host died (the adopt path), false/absent when reattaching a surviving host (the
	 * reconnect path). A cold resume must re-execute its genuinely-in-flight node (re-prime the goal)
	 * instead of waiting on a turn that no live thread is running. Set by the manager at resume time.
	 */
	cold?: boolean;
	/**
	 * Set once the engine escalates a terminal failure (visit-cap-no-overflow, poison cap, no-recovery-
	 * route, or ran-off-the-end — see engine.ts's `terminalFail`). The load-bearing lifecycle bit: a
	 * terminal-marked run is excluded from `resumable`, `reconnectLive`'s auto-resume, and `makeDriver`'s
	 * resumeState, so it is never boot-looped through adoption again. Persisted (unlike the DTO-only
	 * status flip it replaces) so the marker — and the forkAvailable it derives — survive a restart.
	 */
	terminal?: {
		reason: string;
		at: number;
		/** The checkpoint-log entry a fork of this run would restore from. */
		forkPoint: { runId: string; seq: number };
		/** Set once an operator forks this run — the new agent id. Excludes this record from adoption/
		 *  dispatch permanently (one issue, one active claimant) and clears forkAvailable. */
		supersededBy?: string;
	};
}

/**
 * The seam the engine drives execution through. The engine stays pure (graph
 * walking, conditions, retries, gates); an executor decides what "run an agent
 * node" or "raise a human gate" concretely means.
 */
export interface NodeExecutor {
	/** Run an agent / prompt node. */
	runAgent(node: WorkflowNode, ctx: RunContext): Promise<NodeResult>;
	/** Run a command node. */
	runCommand(node: WorkflowNode, ctx: RunContext): Promise<NodeResult>;
	/** Present a human gate; resolve with the chosen edge label (one of `options`). */
	humanGate(node: WorkflowNode, options: string[], ctx: RunContext): Promise<string>;
	/** Run a node carrying an `action="<name>"` attribute — a host-registered domain step. */
	runAction?(node: WorkflowNode, ctx: RunContext): Promise<NodeResult>;
	/** Run a parallel-branch node as an independent unit (e.g. a spawned fleet agent). Falls back to runAgent.
	 * `signal` aborts when the join short-circuits (first_success win) or a sibling threw — honor it to stop the agent.
	 * `branchKey` is the engine's deterministic `${nodeId}#${visitIndex}:${branchIndex}` identity for this branch,
	 * threaded down so the spawner can derive a collision-free, resume-stable agent id. */
	runBranch?(node: WorkflowNode, ctx: RunContext, signal?: AbortSignal, branchKey?: string): Promise<NodeResult>;
	/** Resume an agent / prompt node whose turn may still be in flight from a prior daemon — MUST NOT re-prompt. */
	resumeAgent?(node: WorkflowNode, ctx: RunContext): Promise<NodeResult>;
	/** Optional: observe each stage as it starts / ends. */
	onStage?(ev: StageEvent): void;
}
