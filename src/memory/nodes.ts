import type { Store } from "../dal/store.ts";
import type { PersistedAgent } from "../types.ts";

export type NodeKind = "plan" | "unit" | "subagent" | "landing";

/** Work-state vocabulary accepts agent lifecycle states during the legacy migration. */
export type NodeState = "pending" | "starting" | "working" | "idle" | "input" | "error" | "stopped" | "settled";

/**
 * The states that assert "this unit is alive and doing something RIGHT NOW". Only these are worth
 * sweeping when the agent behind them is gone — they are the ones that mislead an operator reading
 * the fleet. `idle`, `error`, `stopped` and `settled` make no such claim.
 */
const CLAIMS_LIVE: ReadonlySet<NodeState> = new Set<NodeState>(["pending", "starting", "working", "input"]);

/** Activity fades by half every six hours without a new event. */
export const ACTIVITY_HALF_LIFE_MS = 6 * 60 * 60 * 1_000;

/** The durable fields used to order work already assigned to one state region. */
export interface ActivityRankCandidate {
	id: string;
	createdAt?: number;
	lastActivity: number;
	messageCount?: number;
}

/**
 * Recent, dense activity earns prominence; silence fades it out. This deliberately answers only
 * ordering: callers choose state regions before applying it, so a quiet request for help cannot
 * lose to a chatty healthy unit.
 */
function activityScore(candidate: ActivityRankCandidate, now: number): number {
	if (!Number.isFinite(candidate.lastActivity) || candidate.lastActivity <= 0) return 0;
	const lastActivity = Math.min(candidate.lastActivity, now);
	const candidateCreatedAt = candidate.createdAt;
	const createdAt = candidateCreatedAt !== undefined && Number.isFinite(candidateCreatedAt) && candidateCreatedAt > 0 ? Math.min(candidateCreatedAt, lastActivity) : lastActivity;
	const velocity = Math.max(1, candidate.messageCount ?? 0) / Math.max(1, lastActivity - createdAt);
	return velocity * Math.exp((-Math.LN2 * Math.max(0, now - lastActivity)) / ACTIVITY_HALF_LIFE_MS);
}

/** Descending activity score with deterministic, stable fallbacks. */
export function compareActivity(a: ActivityRankCandidate, b: ActivityRankCandidate, now: number): number {
	return activityScore(b, now) - activityScore(a, now) || b.lastActivity - a.lastActivity || a.id.localeCompare(b.id);
}

/** One addressable unit of work and, once somebody speaks, its conversation. */
export interface Node {
	id: string;
	parentId?: string;
	kind: NodeKind;
	title: string;
	state: NodeState;
	ownerId?: string;
	goal?: string;
	createdAt: number;
	settledAt?: number;
	channelId?: string;
}

export type CreateNodeInput = Omit<Node, "channelId"> & { channelId?: never };

/**
 * `PersistedAgent` carries no `status` field — agent status is derived at runtime and never written
 * to disk — so a migrated legacy agent has NO status to migrate from. This used to mint `"working"`
 * unconditionally, which is a claim the data cannot support: it marked long-dead units, adopted
 * units, and units the daemon had never reconnected as actively working, permanently (nothing ever
 * transitions a node whose agent id is no longer in the roster). Six such nodes were still claiming
 * "working" two days after their processes died.
 *
 * `idle` is the honest floor: the unit existed when state was last written, and nothing here knows
 * more than that. A genuinely live agent is corrected within a tick by `refreshNodeSummaries`, so
 * under-claiming costs a moment of staleness while over-claiming costs the operator's trust in the
 * fleet counter.
 */
function nodeFromAgent(agent: PersistedAgent, createdAt: number): Node {
	return {
		id: agent.id,
		parentId: agent.parentId,
		kind: "unit",
		title: agent.name,
		state: "idle",
		goal: agent.task,
		createdAt,
	};
}

/**
 * Durable work graph. Nodes deliberately have no visibility fields: when a node has a channel,
 * ChannelStore is the sole authority for who may read its conversation.
 */
export class NodeStore {
	private migration?: Promise<void>;

	constructor(
		private readonly store: Store,
		private readonly now: () => number = Date.now,
	) {}

	async list(): Promise<Node[]> {
		await this.migrateLegacyAgents();
		return this.store.listNodes();
	}

	async get(id: string): Promise<Node | undefined> {
		await this.migrateLegacyAgents();
		return this.store.getNode(id);
	}

	async create(input: CreateNodeInput): Promise<Node> {
		if (!input.id.trim()) throw new Error("node id required");
		if (!input.title.trim()) throw new Error("node title required");
		const node: Node = { ...input, id: input.id.trim(), title: input.title.trim() };
		await this.store.putNode(node);
		return (await this.store.getNode(node.id)) ?? node;
	}

	/** Update lifecycle state without overloading the node with derived evidence. */
	async transition(id: string, state: NodeState, now = this.now()): Promise<Node | undefined> {
		const current = await this.get(id);
		if (!current) return undefined;
		const node: Node = {
			...current,
			state,
			settledAt: state === "settled" ? current.settledAt ?? now : undefined,
		};
		await this.store.putNode(node);
		return (await this.store.getNode(id)) ?? node;
	}

	/**
	 * Settle unit nodes that CLAIM to be live but have no agent behind them any more.
	 *
	 * A node's LIFECYCLE state is driven by `refreshNodeSummaries`, which needs a live `AgentRecord`
	 * under the SAME id. (Node rows are also written by `create`, `transition` and the legacy
	 * migration — this is a statement about what moves a node through its lifecycle, not about who
	 * may write the row.) Cold adoption mints a fresh agent id for a recovered worktree, so the node
	 * belonging to the old id is orphaned by construction — frozen at whatever it last claimed, with
	 * nothing that will ever move it again: there is no `deleteNode`, and every existing reaper works
	 * on the roster, sockets, or worktrees rather than on nodes. That is how six units went on
	 * reporting "working" for two days after their processes were gone.
	 *
	 * Only `kind === "unit"` nodes are swept, and only out of states that assert something is running
	 * right now. Synthetic container nodes (the root `fleet` plan) have no agent by design and must
	 * not be settled out from under the tree, and a node that already reads `idle`/`error`/`settled`
	 * is not lying about work even if its agent is gone.
	 *
	 * Takes a PREDICATE rather than a snapshot of live ids on purpose. The caller runs this on the boot
	 * path today, but the roster is mutable and this walks the whole graph; re-asking per candidate,
	 * immediately before the write, means a unit that came alive mid-sweep can never be stopped by a
	 * decision made microseconds earlier — and keeps it safe to move off the boot path later.
	 */
	async reconcileOrphans(isLive: (id: string) => boolean): Promise<Node[]> {
		const stopped: Node[] = [];
		for (const node of await this.list()) {
			if (node.kind !== "unit" || isLive(node.id) || !CLAIMS_LIVE.has(node.state)) continue;
			// "stopped", not "settled": the unit ended without choosing to, and settled means finished.
			// Matches `transition`, which only stamps `settledAt` for a genuine settle.
			const next: Node = { ...node, state: "stopped", settledAt: undefined };
			await this.store.putNode(next);
			stopped.push(next);
		}
		return stopped;
	}

	/** Idempotently materialize unit nodes for state written before nodes existed. */
	async migrateLegacyAgents(): Promise<void> {
		this.migration ??= (async () => {
			const [existing, state] = await Promise.all([this.store.listNodes(), this.store.load()]);
			const known = new Set(existing.map((node) => node.id));
			const createdAt = this.now();
			await Promise.all(state.agents.filter((agent) => !known.has(agent.id)).map((agent) => this.store.putNode(nodeFromAgent(agent, createdAt))));
		})();
		await this.migration;
	}
}
