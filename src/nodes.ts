import type { Store } from "./dal/store.ts";
import type { PersistedAgent } from "./types.ts";

export type NodeKind = "plan" | "unit" | "subagent" | "landing";

/** Work-state vocabulary accepts agent lifecycle states during the legacy migration. */
export type NodeState = "pending" | "starting" | "working" | "idle" | "input" | "error" | "stopped" | "settled";

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
