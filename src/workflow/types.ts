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
}

/** Persisted run state — an engine checkpoint plus the executor's stage rollup (for the progress view). */
export interface WorkflowRunState extends EngineCheckpoint {
	rollup: { label: string; status: "in_progress" | "completed" }[];
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
	 * `signal` aborts when the join short-circuits (first_success win) or a sibling threw — honor it to stop the agent. */
	runBranch?(node: WorkflowNode, ctx: RunContext, signal?: AbortSignal): Promise<NodeResult>;
	/** Resume an agent / prompt node whose turn may still be in flight from a prior daemon — MUST NOT re-prompt. */
	resumeAgent?(node: WorkflowNode, ctx: RunContext): Promise<NodeResult>;
	/** Optional: observe each stage as it starts / ends. */
	onStage?(ev: StageEvent): void;
}
