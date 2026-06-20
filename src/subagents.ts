/**
 * SubagentTracker — turns omp's RPC subagent event stream into a live tree.
 *
 * An omp agent can spawn its own subagents via the `task` tool; omp surfaces
 * them over the RPC session as three frame kinds:
 *
 *   - `subagent_lifecycle` — a spawn started / completed / failed / aborted.
 *   - `subagent_progress`  — a periodic `AgentProgress` snapshot (status, tool, …).
 *   - `subagent_event`     — a forwarded `AgentSessionEvent` from the child (heartbeat).
 *
 * We also reconcile against the full `get_subagents` response (an array of
 * `RpcSubagentSnapshot`). All state is kept in a plain in-memory `Map` keyed by
 * the dynamic subagent id; nothing is persisted here. We import omp's RPC
 * *types* (erased at runtime) to stay faithful to the wire contract.
 */

import type {
	RpcSubagentSnapshot,
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
	RpcSubagentEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type LifecyclePayload = RpcSubagentLifecycleFrame["payload"];
type ProgressPayload = RpcSubagentProgressFrame["payload"];
type EventPayload = RpcSubagentEventFrame["payload"];

/** One node in the live subagent tree, projected for display. */
export interface SubagentNode {
	id: string;
	agent: string;
	description?: string;
	status: string;
	task?: string;
	lastUpdate: number;
}

/** Internal node: the public fields plus the spawn `index` we sort on but don't expose. */
interface TrackedSubagent extends SubagentNode {
	index: number;
}

/**
 * Lifecycle frames speak `started/completed/failed/aborted`, while progress
 * frames and snapshots speak the `AgentProgress` vocabulary (`running/…`). Map
 * lifecycle status into that shared vocabulary so a node's `status` is uniform
 * regardless of which frame last touched it.
 */
const LIFECYCLE_STATUS: Record<LifecyclePayload["status"], string> = {
	started: "running",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

/** Fields an ingest may contribute; `undefined` means "leave whatever we already have". */
interface NodeFields {
	agent?: string;
	description?: string;
	status?: string;
	task?: string;
}

export class SubagentTracker {
	private readonly nodes = new Map<string, TrackedSubagent>();

	/**
	 * Fold one RPC frame into the tree. Handles `subagent_lifecycle`,
	 * `subagent_progress`, and `subagent_event`; ignores everything else.
	 * Returns `true` iff a node was created or any tracked field changed.
	 */
	ingest(frame: { type: string; payload?: unknown }): boolean {
		const payload = frame.payload;
		if (payload === null || typeof payload !== "object") return false;
		switch (frame.type) {
			case "subagent_lifecycle":
				return this.ingestLifecycle(payload as LifecyclePayload);
			case "subagent_progress":
				return this.ingestProgress(payload as ProgressPayload);
			case "subagent_event":
				return this.ingestEvent(payload as EventPayload);
			default:
				return false;
		}
	}

	/**
	 * Reconcile from a `get_subagents` response. Each snapshot is authoritative
	 * for the fields and `lastUpdate` it carries, so we upsert every entry. We do
	 * not prune nodes absent from `snaps`: a `subagent_lifecycle`/`progress` frame
	 * can legitimately arrive between two refreshes, and dropping it would flicker
	 * the live tree.
	 */
	applySnapshot(snaps: RpcSubagentSnapshot[]): void {
		for (const s of snaps) {
			if (typeof s.id !== "string") continue;
			const existing = this.nodes.get(s.id);
			if (!existing) {
				this.nodes.set(s.id, {
					id: s.id,
					agent: s.agent,
					description: s.description,
					status: s.status,
					task: s.task,
					index: s.index,
					lastUpdate: s.lastUpdate,
				});
				continue;
			}
			existing.agent = s.agent;
			if (s.description !== undefined) existing.description = s.description;
			existing.status = s.status;
			if (s.task !== undefined) existing.task = s.task;
			existing.index = s.index;
			existing.lastUpdate = s.lastUpdate;
		}
	}

	/** Current nodes, ordered by spawn `index` then `lastUpdate`. */
	list(): SubagentNode[] {
		const sorted = [...this.nodes.values()].sort(
			(a, b) => a.index - b.index || a.lastUpdate - b.lastUpdate,
		);
		return sorted.map((n) => ({
			id: n.id,
			agent: n.agent,
			description: n.description,
			status: n.status,
			task: n.task,
			lastUpdate: n.lastUpdate,
		}));
	}

	clear(): void {
		this.nodes.clear();
	}

	private ingestLifecycle(p: LifecyclePayload): boolean {
		if (typeof p.id !== "string") return false;
		return this.upsert(
			p.id,
			p.index,
			{ agent: p.agent, description: p.description, status: LIFECYCLE_STATUS[p.status] },
			Date.now(),
		);
	}

	private ingestProgress(p: ProgressPayload): boolean {
		const prog = p.progress;
		if (!prog || typeof prog.id !== "string") return false;
		return this.upsert(
			prog.id,
			p.index,
			{
				agent: p.agent ?? prog.agent,
				description: prog.description,
				status: prog.status,
				task: p.task ?? prog.task,
			},
			Date.now(),
		);
	}

	/**
	 * An event frame is a pure activity heartbeat for an already-known subagent —
	 * it carries no roster fields, so the only state it advances is `lastUpdate`.
	 */
	private ingestEvent(p: EventPayload): boolean {
		if (typeof p.id !== "string") return false;
		const node = this.nodes.get(p.id);
		if (!node) return false;
		node.lastUpdate = Date.now();
		return true;
	}

	/** Create or field-merge a node; bumps `lastUpdate` only when something changed. */
	private upsert(id: string, index: number, fields: NodeFields, timestamp: number): boolean {
		const existing = this.nodes.get(id);
		if (!existing) {
			this.nodes.set(id, {
				id,
				agent: fields.agent ?? "",
				description: fields.description,
				status: fields.status ?? "pending",
				task: fields.task,
				index,
				lastUpdate: timestamp,
			});
			return true;
		}
		let changed = false;
		if (fields.agent !== undefined && fields.agent !== existing.agent) {
			existing.agent = fields.agent;
			changed = true;
		}
		if (fields.description !== undefined && fields.description !== existing.description) {
			existing.description = fields.description;
			changed = true;
		}
		if (fields.status !== undefined && fields.status !== existing.status) {
			existing.status = fields.status;
			changed = true;
		}
		if (fields.task !== undefined && fields.task !== existing.task) {
			existing.task = fields.task;
			changed = true;
		}
		if (index !== existing.index) {
			existing.index = index;
			changed = true;
		}
		if (changed) existing.lastUpdate = timestamp;
		return changed;
	}
}
