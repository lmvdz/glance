import type { Store } from "./dal/store.ts";
import type { PersistedAgent } from "./types.ts";

export type NodeKind = "plan" | "unit" | "subagent" | "landing";

/** Work-state vocabulary accepts agent lifecycle states during the legacy migration. */
export type NodeState = "pending" | "starting" | "working" | "idle" | "input" | "error" | "stopped" | "settled";

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

function nodeFromAgent(agent: PersistedAgent, createdAt: number): Node {
	return {
		id: agent.id,
		parentId: agent.parentId,
		kind: "unit",
		title: agent.name,
		state: "working",
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
