/**
 * Deterministic suite for SubagentTracker — no model tokens spent.
 *
 * Drives synthetic RPC subagent frames (lifecycle → progress → event) plus a
 * `get_subagents` snapshot through the tracker and asserts the projected tree
 * reflects status/description/task, sorts by spawn index, and that `ingest`
 * reports change vs. no-op honestly.
 */

import { expect, test } from "bun:test";
import { SubagentTracker, type SubagentNode } from "../src/subagents.ts";
import type { RpcSubagentSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const find = (list: SubagentNode[], id: string): SubagentNode | undefined =>
	list.find((n) => n.id === id);

test("ingest folds lifecycle → progress → event into one live node", () => {
	const t = new SubagentTracker();

	// subagent_lifecycle (started → running): a detached scout spins up.
	const created = t.ingest({
		type: "subagent_lifecycle",
		payload: {
			id: "alpha",
			agent: "explore",
			agentSource: "bundled",
			description: "scout the auth module",
			status: "started",
			index: 0,
			detached: true,
		},
	});
	expect(created).toBe(true);
	let node = find(t.list(), "alpha");
	expect(node?.status).toBe("running"); // lifecycle "started" maps into AgentProgress vocab
	expect(node?.agent).toBe("explore");
	expect(node?.description).toBe("scout the auth module");
	expect(node?.task).toBeUndefined(); // lifecycle carries no task yet

	// subagent_progress: status holds, description advances, task surfaces.
	const progressFrame = {
		type: "subagent_progress",
		payload: {
			index: 0,
			agent: "explore",
			agentSource: "bundled",
			task: "map callers of login()",
			progress: {
				id: "alpha",
				index: 0,
				agent: "explore",
				agentSource: "bundled",
				status: "running",
				task: "map callers of login()",
				description: "reading auth.ts",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		},
	};
	expect(t.ingest(progressFrame)).toBe(true);
	node = find(t.list(), "alpha");
	expect(node?.status).toBe("running");
	expect(node?.description).toBe("reading auth.ts");
	expect(node?.task).toBe("map callers of login()");

	// Re-feeding the identical progress changes nothing → no-op.
	expect(t.ingest(progressFrame)).toBe(false);

	// subagent_event: a heartbeat for a known node bumps recency → change.
	const before = find(t.list(), "alpha")?.lastUpdate ?? 0;
	const evt = t.ingest({
		type: "subagent_event",
		payload: { id: "alpha", event: { type: "agent_end" } },
	});
	expect(evt).toBe(true);
	expect((find(t.list(), "alpha")?.lastUpdate ?? 0) >= before).toBe(true);

	// An event for an unknown id can't advance anything → no-op.
	expect(
		t.ingest({ type: "subagent_event", payload: { id: "ghost", event: { type: "agent_end" } } }),
	).toBe(false);

	// Unrelated frame kinds and malformed payloads are ignored.
	expect(t.ingest({ type: "message_update", payload: {} })).toBe(false);
	expect(t.ingest({ type: "subagent_lifecycle" })).toBe(false);
});

test("applySnapshot reconciles a get_subagents response and list() sorts by index", () => {
	const t = new SubagentTracker();

	// A pre-existing node from a lifecycle frame...
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 1 },
	});
	expect(find(t.list(), "a")?.status).toBe("running");

	// ...gets reconciled by the authoritative snapshot, and a new node appears.
	const snaps: RpcSubagentSnapshot[] = [
		{
			id: "a",
			index: 1,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			task: "finished the refactor",
			lastUpdate: 200,
		},
		{
			id: "b",
			index: 0,
			agent: "reviewer",
			agentSource: "user",
			description: "review the diff",
			status: "running",
			task: "review",
			lastUpdate: 100,
		},
	];
	t.applySnapshot(snaps);

	const list = t.list();
	expect(list.map((n) => n.id)).toEqual(["b", "a"]); // index 0 before index 1

	const a = find(list, "a");
	expect(a?.status).toBe("completed"); // snapshot overrode the live "running"
	expect(a?.task).toBe("finished the refactor");

	const b = find(list, "b");
	expect(b?.agent).toBe("reviewer");
	expect(b?.description).toBe("review the diff");
	expect(b?.status).toBe("running");
});

test("clear empties the tracker", () => {
	const t = new SubagentTracker();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "x", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	expect(t.list()).toHaveLength(1);
	t.clear();
	expect(t.list()).toEqual([]);
});
