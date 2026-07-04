/**
 * Deterministic suite for SubagentTracker — no model tokens spent.
 *
 * Drives synthetic RPC subagent frames (lifecycle → progress → event) plus a
 * `get_subagents` snapshot through the tracker and asserts the projected tree
 * reflects status/description/task, sorts by spawn index, and that `ingest`
 * reports change vs. no-op honestly.
 */

import { expect, test } from "bun:test";
import { SubagentTracker, mergeSubagents, type SubagentNode } from "../src/subagents.ts";
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

// ── isDirty()/clearDirty() ────────────────────────────────────────────────────

test("isDirty(): set on node creation, cleared by clearDirty()", () => {
	const t = new SubagentTracker();
	expect(t.isDirty()).toBe(false);
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	expect(t.isDirty()).toBe(true);
	t.clearDirty();
	expect(t.isDirty()).toBe(false);
});

test("isDirty(): set on a real field transition", () => {
	const t = new SubagentTracker();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	t.clearDirty();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "completed", index: 0 },
	});
	expect(t.isDirty()).toBe(true);
});

test("isDirty(): NOT set on a no-op re-ingest of the identical frame", () => {
	const t = new SubagentTracker();
	const frame = {
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	};
	t.ingest(frame);
	t.clearDirty();
	expect(t.ingest(frame)).toBe(false);
	expect(t.isDirty()).toBe(false);
});

test("isDirty(): NOT set by a pure subagent_event heartbeat, even though ingest() returns true", () => {
	const t = new SubagentTracker();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	t.clearDirty();
	const changed = t.ingest({ type: "subagent_event", payload: { id: "a", event: { type: "agent_end" } } });
	expect(changed).toBe(true); // the tracker DID advance (lastUpdate bumped)...
	expect(t.isDirty()).toBe(false); // ...but a heartbeat alone must never trigger a flush
});

// ── closeNonTerminal() ────────────────────────────────────────────────────────

test("closeNonTerminal(): stamps only non-terminal nodes aborted, leaves terminal nodes untouched", () => {
	const t = new SubagentTracker();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "running", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "done", agent: "task", agentSource: "bundled", status: "completed", index: 1 },
	});
	t.clearDirty();
	t.closeNonTerminal();
	expect(t.isDirty()).toBe(true);
	expect(find(t.list(), "running")?.status).toBe("aborted");
	expect(find(t.list(), "done")?.status).toBe("completed"); // untouched — already terminal
});

test("closeNonTerminal(): idempotent — a second call once everything is terminal is a no-op", () => {
	const t = new SubagentTracker();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	t.closeNonTerminal();
	t.clearDirty();
	t.closeNonTerminal(); // every node is already terminal ("aborted")
	expect(t.isDirty()).toBe(false);
});

// ── mergeSubagents() ──────────────────────────────────────────────────────────

test("mergeSubagents(): a live id (still in progress, or reseeded on restore) wins over its persisted copy, and a persisted-only sibling from the SAME run survives the union", () => {
	// "b" is persisted-only but NOT from an earlier run here — it's a sibling of "a" that got flushed to
	// disk by an earlier dirty-flush THIS run, while "a" (still live) and "c" (freshly ingested) round out
	// the same run's current tracker snapshot. This is the one shape where a persisted-only entry sits in
	// the SAME run as `live`'s entries: nothing has been cleared yet, so `live` legitimately doesn't (yet)
	// carry every id `persisted` does.
	const persisted: SubagentNode[] = [
		{ id: "a", agent: "explore", status: "running", lastUpdate: 100, index: 0 },
		{ id: "b", agent: "reviewer", status: "completed", lastUpdate: 50, index: 1 },
	];
	const live: SubagentNode[] = [
		{ id: "a", agent: "explore", status: "completed", lastUpdate: 200, index: 0 }, // live wins over persisted "a"
		{ id: "c", agent: "worker", status: "running", lastUpdate: 300, index: 2 }, // live-only, tracker still has it
	];
	const merged = mergeSubagents(persisted, live);
	expect(merged.find((n) => n.id === "a")?.status).toBe("completed"); // live wins
	expect(merged.find((n) => n.id === "b")).toBeDefined(); // persisted-only entry survives the union
	// "a" and "c" (both currently live) sort together by index; "b" (persisted-only) keeps its given
	// position in `persisted` rather than being re-interleaved by a raw index comparison against them.
	expect(merged.map((n) => n.id)).toEqual(["b", "a", "c"]);
});

test("mergeSubagents(): treats undefined persisted as empty, still returns live", () => {
	const live: SubagentNode[] = [{ id: "a", agent: "explore", status: "running", lastUpdate: 100, index: 0 }];
	expect(mergeSubagents(undefined, live)).toEqual(live);
});

test("mergeSubagents(): equal index within the SAME (live) run falls back to lastUpdate for a stable order", () => {
	const live: SubagentNode[] = [
		{ id: "old", agent: "x", status: "running", lastUpdate: 100, index: 0 },
		{ id: "new", agent: "y", status: "running", lastUpdate: 200, index: 0 },
	];
	expect(mergeSubagents(undefined, live).map((n) => n.id)).toEqual(["old", "new"]);
});

// Topology review finding 6: `index` resets to 0 at the start of every run (the tracker is cleared at
// every restart), so a bare "sort the union by index" interleaves two runs' children whenever their
// indices tie. `persisted` here is run 1's history, already flushed and CLEARED from the tracker before
// run 2 (fresh ids `c`/`d`) ever ingested a frame — the exact real-world shape the bug hits, since an id
// only ever lands in `persisted`-but-not-`live` at a genuine run boundary.
test("mergeSubagents(): two runs' children stay contiguous and chronological, never interleaved by index", () => {
	const run1: SubagentNode[] = [
		{ id: "a", agent: "explore", status: "completed", lastUpdate: 100, index: 0 },
		{ id: "b", agent: "reviewer", status: "completed", lastUpdate: 150, index: 1 },
	];
	const run2Live: SubagentNode[] = [
		{ id: "c", agent: "explore", status: "running", lastUpdate: 500, index: 0 },
		{ id: "d", agent: "reviewer", status: "running", lastUpdate: 550, index: 1 },
	];
	const merged = mergeSubagents(run1, run2Live);
	// Chronological and grouped by run — NOT ["a", "c", "b", "d"], the index-tie interleaving the bug produced.
	expect(merged.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
});

test("mergeSubagents(): a full reseed of persisted history into live (restore/reattach) reproduces the same single-run order as before, no spurious run split", () => {
	const persisted: SubagentNode[] = [
		{ id: "a", agent: "explore", status: "completed", lastUpdate: 100, index: 0 },
		{ id: "b", agent: "reviewer", status: "running", lastUpdate: 150, index: 1 },
	];
	// applySnapshot() reseeds the WHOLE persisted history into the live tracker on reattach/restore — every
	// id `persisted` has is also in `live`, so nothing should be misclassified as "an earlier run".
	const reseededLive: SubagentNode[] = [
		{ id: "a", agent: "explore", status: "completed", lastUpdate: 100, index: 0 },
		{ id: "b", agent: "reviewer", status: "aborted", lastUpdate: 999, index: 1 }, // closeNonTerminal closed it
	];
	const merged = mergeSubagents(persisted, reseededLive);
	expect(merged.map((n) => n.id)).toEqual(["a", "b"]);
	expect(merged.find((n) => n.id === "b")?.status).toBe("aborted"); // live (post-closure) wins
});

// ── the race this concern fixes ───────────────────────────────────────────────

test("a progress frame carrying the terminal status BEFORE the matching lifecycle frame is not reverted", () => {
	const t = new SubagentTracker();
	t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "started", index: 0 },
	});
	t.clearDirty();

	// The progress frame arrives FIRST carrying the already-terminal status (race condition this concern
	// fixes: omp can emit `subagent_progress` and `subagent_lifecycle` out of order).
	const progressChanged = t.ingest({
		type: "subagent_progress",
		payload: {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			progress: {
				id: "a",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "completed",
				task: "done",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		},
	});
	expect(progressChanged).toBe(true);
	expect(t.isDirty()).toBe(true); // dirty was set at the progress step, not waiting for lifecycle
	expect(find(t.list(), "a")?.status).toBe("completed");
	t.clearDirty();

	// The matching lifecycle "completed" frame arrives second. LIFECYCLE_STATUS maps it to "completed" too,
	// which is already the current value — a no-op under upsert's diff logic. The status must NOT revert.
	const lifecycleChanged = t.ingest({
		type: "subagent_lifecycle",
		payload: { id: "a", agent: "task", agentSource: "bundled", status: "completed", index: 0 },
	});
	expect(lifecycleChanged).toBe(false); // no-change: status was already "completed"
	expect(find(t.list(), "a")?.status).toBe("completed"); // still completed, never reverted
});
