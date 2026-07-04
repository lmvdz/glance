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
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
	RpcSubagentEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { redact } from "./redact.ts";

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
	/** Spawn order within the parent run. Exposed (unlike before) so a persisted snapshot round-trips
	 *  ordering and a reseeded tracker (applySnapshot on reattach) sorts identically to the live tree. */
	index: number;
}

/** The tree is a flat Map keyed by subagent id — no parent pointer. A subagent that itself spawns
 *  subagents would silently flatten into the same tree today; nesting is out of scope for this slice. */
type TrackedSubagent = SubagentNode;

/**
 * Persisted-snapshot projection: truncates task/description to 240 chars + redacts, same discipline as
 * span attrs (spans.ts:91). The live in-memory tracker (used by the polling endpoint) keeps full text —
 * only what rides the roster snapshot / SSE agent DTO gets bounded.
 */
function toPersisted(n: SubagentNode): SubagentNode {
	return {
		...n,
		description: n.description !== undefined ? redact(n.description).slice(0, 240) : undefined,
		task: n.task !== undefined ? redact(n.task).slice(0, 240) : undefined,
	};
}

/**
 * The single read/write contract for subagent lineage: persisted history ∪ live tracker, live wins per
 * id. Used both to compute what a flush writes AND what every reader (manager.subagents(), the
 * GET /api/agents/:id/subagents endpoint) returns — so the two surfaces can never drift, by construction.
 *
 * Topology review finding 6: `index` is spawn order WITHIN one run only (SubagentNode's own doc: "Spawn
 * order within the parent run") — the tracker's node map is cleared at every restart (squad-manager.ts's
 * `restart()`/close+clear sites), so a NEW run's first spawn is index 0 again. A single `sort by index`
 * across the union therefore interleaves runs whenever their indices tie (run 2's children splicing
 * between run 1's: s1(0), s3(0), s2(1), s4(1) instead of s1, s2, s3, s4).
 *
 * Fixed by grouping on RUN membership instead of comparing `index` across the whole union: any id the
 * CURRENT tracker (`live`) itself carries belongs to the run in progress (or, on a reseed-from-persisted
 * reattach, is being actively re-hosted by the live tracker — either way `live`'s copy is authoritative,
 * matching the existing "live wins" rule). Everything left in `persisted` once those ids are excluded is
 * strictly earlier history, and its relative order is PRESERVED AS GIVEN rather than re-derived: an
 * earlier call to this same function already ordered it correctly (run-by-run, chronologically), and a
 * fresh `index`-only sort over that blob would re-introduce the exact cross-run interleaving this fix
 * removes, since `index` repeats in every run and was never meant to be globally comparable. `live` is
 * still ordered internally by spawn order (ties broken by `lastUpdate`) — the same contract `list()`/
 * `snapshot()` promise, reproduced here since this is an exported function any caller may feed an
 * arbitrary `SubagentNode[]`, not only `SubagentTracker`'s own.
 */
export function mergeSubagents(persisted: SubagentNode[] | undefined, live: SubagentNode[]): SubagentNode[] {
	const liveIds = new Set(live.map((l) => l.id));
	const priorRuns = (persisted ?? []).filter((p) => !liveIds.has(p.id));
	const currentRun = [...live].sort((a, b) => a.index - b.index || a.lastUpdate - b.lastUpdate);
	return [...priorRuns, ...currentRun];
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

	/** True iff a node was created or any tracked field transitioned since the last clearDirty(). Heartbeats
	 *  (ingestEvent) and no-op re-ingests never set this — write volume stays proportional to real change. */
	private dirty = false;

	isDirty(): boolean {
		return this.dirty;
	}

	clearDirty(): void {
		this.dirty = false;
	}

	/** The persisted-projection snapshot (truncated/redacted), ordered like list(). */
	snapshot(): SubagentNode[] {
		return this.list().map(toPersisted);
	}

	/**
	 * Fold one RPC frame into the tree. Handles `subagent_lifecycle`,
	 * `subagent_progress`, and `subagent_event`; ignores everything else.
	 * Returns `true` iff a node was created or any tracked field changed.
	 *
	 * Dirty tracking is transition-based, not frame-type-based: any real change from
	 * `subagent_lifecycle`/`subagent_progress` marks dirty (using each ingestX's own diff-computed
	 * return value), regardless of which frame kind carried it — this closes the race where a progress
	 * frame carries a terminal status before the matching lifecycle frame arrives (a lifecycle-only dirty
	 * gate would miss it since LIFECYCLE_STATUS mapping makes the later lifecycle ingest a no-change).
	 * `subagent_event` is excluded from dirty even when it returns `true`: it only ever bumps `lastUpdate`
	 * on an already-known node (a pure heartbeat), so counting it would flush on every heartbeat and
	 * inflate write volume far beyond what the tracked content actually warrants.
	 */
	ingest(frame: { type: string; payload?: unknown }): boolean {
		const payload = frame.payload;
		if (payload === null || typeof payload !== "object") return false;
		let changed = false;
		switch (frame.type) {
			case "subagent_lifecycle":
				changed = this.ingestLifecycle(payload as LifecyclePayload);
				break;
			case "subagent_progress":
				changed = this.ingestProgress(payload as ProgressPayload);
				break;
			case "subagent_event":
				changed = this.ingestEvent(payload as EventPayload);
				break;
			default:
				return false;
		}
		if (changed && frame.type !== "subagent_event") this.dirty = true;
		return changed;
	}

	/**
	 * Stamp every non-terminal node aborted (run ended/agent stopped without a terminal frame for it), and
	 * mark dirty so the caller's next flush persists the closure. Idempotent — a second call after all nodes
	 * are already terminal is a no-op (dirty stays false from this call). Call at finalizeRun and at the
	 * restart() clear site, BEFORE clearing, so a persisted entry can never claim "running" under a stopped
	 * agent.
	 */
	closeNonTerminal(): void {
		const TERMINAL = new Set(["completed", "failed", "aborted"]);
		for (const n of this.nodes.values()) {
			if (!TERMINAL.has(n.status)) {
				n.status = "aborted";
				n.lastUpdate = Date.now();
				this.dirty = true;
			}
		}
	}

	/**
	 * Reconcile from a `get_subagents` response, OR reseed a fresh tracker from a persisted `SubagentNode[]`
	 * snapshot on reattach/adopt (both shapes satisfy this signature — the RPC snapshot carries extra fields
	 * this method never reads). Each entry is authoritative for the fields and `lastUpdate` it carries, so we
	 * upsert every entry. We do not prune nodes absent from `snaps`: a `subagent_lifecycle`/`progress` frame
	 * can legitimately arrive between two refreshes (or between reseed and the next live frame), and dropping
	 * it would flicker the live tree.
	 */
	applySnapshot(snaps: SubagentNode[]): void {
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
			index: n.index,
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
