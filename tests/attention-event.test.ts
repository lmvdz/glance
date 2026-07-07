/**
 * attention-event.test.ts — the non-blocking "agent/operator-declared attention" primitive
 * (cmux-research concern 03, harness-agnostic `glance notify`). Three ingress paths all append to
 * the same `AgentDTO.attentionEvents` channel, tagged by `source`:
 *   - "notify"  operator/CLI/scriptable ingress, `{ type: "notify" }` ClientCommand → applyCommand.
 *   - "tool"    an omp agent's `squad_attention` host tool call → handleAttentionTool.
 *   - "harness" a non-omp harness's RPC `notify` extension-UI method → onUi (previously inert).
 * Deliberately NOT a PendingRequest (same non-blocking contract as squad_report/AgentReport): none
 * of these three paths may touch `pending` or flip `status` to "input".
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, AttentionEvent, PersistedAgent, RpcExtensionUIRequest, RpcSessionState } from "../src/types.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];

afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A no-op AgentDriver — enough for applyCommand("notify")/onUi("notify"), which never touch it. */
class FakeDriver extends EventEmitter {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in these tests"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

/** SquadManager subclass exposing the protected `onUi` seam, same pattern as gate-class.test.ts. */
class TestManager extends SquadManager {
	fireUi(id: string, req: RpcExtensionUIRequest): void {
		const rec = this.agents.get(id);
		if (rec) this.onUi(rec, req);
	}
}

async function freshManager(): Promise<TestManager> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "attention-event-"));
	tmps.push(stateDir);
	const m = new TestManager({ stateDir });
	managers.push(m);
	return m;
}

function seed(mgr: TestManager, id: string): FakeDriver {
	const agent = new FakeDriver();
	const dto: AgentDTO = {
		id,
		name: id,
		status: "working",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: agent as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
	return agent;
}

test('a {type:"notify"} ClientCommand appends an attentionEvents entry with source "notify", never touching pending/status', async () => {
	const mgr = await freshManager();
	seed(mgr, "a1");

	await mgr.applyCommand({ type: "notify", id: "a1", summary: "please review the migration plan", detail: "see docs/migration.md" });

	const dto = mgr.getAgent("a1");
	const events = dto?.attentionEvents as AttentionEvent[] | undefined;
	expect(events).toHaveLength(1);
	expect(events![0].source).toBe("notify");
	expect(events![0].summary).toBe("please review the migration plan");
	expect(events![0].detail).toBe("see docs/migration.md");
	expect(typeof events![0].id).toBe("string");
	expect(typeof events![0].createdAt).toBe("number");

	// Non-blocking, by construction.
	expect(dto?.pending).toEqual([]);
	expect(dto?.status).toBe("working");

	// A transcript line was also written (operator-facing record of the notify).
	const transcript = mgr.getTranscript("a1");
	expect(transcript.some((e) => e.text.includes("please review the migration plan"))).toBe(true);
});

test('the squad_attention host tool responds immediately and appends an attentionEvents entry with source "tool"', async () => {
	const mgr = await freshManager();
	seed(mgr, "a1");
	const rec = mgr.agents.get("a1")!;
	const cap: { tool?: { text: string; isError: boolean } } = {};
	rec.agent.respondHostTool = (_id: string, text: string, isError = false) => {
		cap.tool = { text, isError };
	};

	await (mgr as unknown as { handleAttentionTool: (r: unknown, c: unknown) => Promise<void> }).handleAttentionTool(rec, {
		id: "call-1",
		arguments: { summary: "found a flaky test", detail: "tests/foo.test.ts times out ~5% of runs" },
	});

	expect(cap.tool).toBeDefined();
	expect(cap.tool!.isError).toBeFalsy();

	const events = rec.dto.attentionEvents as AttentionEvent[] | undefined;
	expect(events).toHaveLength(1);
	expect(events![0].source).toBe("tool");
	expect(events![0].summary).toBe("found a flaky test");
	expect(events![0].detail).toBe("tests/foo.test.ts times out ~5% of runs");

	expect(rec.dto.pending).toEqual([]);
	expect(rec.dto.status).toBe("working");
});

test("squad_attention with an empty summary returns a usage error and appends nothing", async () => {
	const mgr = await freshManager();
	seed(mgr, "a1");
	const rec = mgr.agents.get("a1")!;
	const cap: { tool?: { text: string; isError: boolean } } = {};
	rec.agent.respondHostTool = (_id: string, text: string, isError = false) => {
		cap.tool = { text, isError };
	};

	await (mgr as unknown as { handleAttentionTool: (r: unknown, c: unknown) => Promise<void> }).handleAttentionTool(rec, { id: "call-1", arguments: {} });

	expect(cap.tool!.isError).toBe(true);
	expect(cap.tool!.text).toContain("usage: squad_attention");
	expect(rec.dto.attentionEvents ?? []).toHaveLength(0);
});

test('an onUi "notify" RPC method appends an attentionEvents entry with source "harness" AND still writes the transcript line (previously inert)', async () => {
	const mgr = await freshManager();
	seed(mgr, "a1");

	mgr.fireUi("a1", { type: "extension_ui_request", id: "n1", method: "notify", message: "context window nearing limit", notifyType: "warn" } as RpcExtensionUIRequest);

	const dto = mgr.getAgent("a1");
	const events = dto?.attentionEvents as AttentionEvent[] | undefined;
	expect(events).toHaveLength(1);
	expect(events![0].source).toBe("harness");
	expect(events![0].summary).toBe("context window nearing limit");

	// The pre-existing transcript-only behavior must still hold — this is additive, not a replacement.
	const transcript = mgr.getTranscript("a1");
	expect(transcript.some((e) => e.text.includes("context window nearing limit"))).toBe(true);

	// Non-blocking, by construction: never touches pending or status.
	expect(dto?.pending).toEqual([]);
});

test("attentionEvents is append-only across repeated notifies from different sources", async () => {
	const mgr = await freshManager();
	seed(mgr, "a1");

	await mgr.applyCommand({ type: "notify", id: "a1", summary: "operator flag" });
	const rec = mgr.agents.get("a1")!;
	await (mgr as unknown as { handleAttentionTool: (r: unknown, c: unknown) => Promise<void> }).handleAttentionTool(rec, { id: "call-1", arguments: { summary: "tool flag" } });
	mgr.fireUi("a1", { type: "extension_ui_request", id: "n1", method: "notify", message: "harness flag" } as RpcExtensionUIRequest);

	const events = mgr.getAgent("a1")?.attentionEvents as AttentionEvent[] | undefined;
	expect(events).toHaveLength(3);
	expect(events!.map((e) => e.source)).toEqual(["notify", "tool", "harness"]);
});
