/**
 * Live incident (2026-07-20 cockpit screenshot): a `glance here` chat's agent process exited 143
 * mid-turn. The roster endpoint honestly flipped the unit to the error tier — sidebar: "agent
 * exited (code 143) · Blocked for 38s" — while the chat pane kept an animated "Working for 39s"
 * forever. Root cause: the exit handler stamped unit.status/unit.error but never settled the
 * transcript entries still `status:"running"`, and the cockpit's working row keys purely on that
 * per-entry status. Nothing could ever settle them again (the process that owned the stream was
 * dead), so the two surfaces disagreed permanently — and the stale `running` entries were even
 * persisted, surviving daemon restarts.
 *
 * These tests pin the fix: on process exit every still-running transcript entry settles to a
 * terminal status (error for a crash, matching the unit tier; cancelled for clean teardown),
 * the settle is re-emitted on the live event channel, and the persisted snapshot carries the
 * terminal status — plus the pure dead-placeholder path settles recovered tails the same way.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { FileStore } from "../src/dal/store.ts";
import { buildDeadPlaceholder } from "../src/reattach-context.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcExtensionUIRequest, RpcSessionState, SquadEvent, TranscriptEntry } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";
// Save/restore, not a bare set (bun runs every test file in ONE process — see the env-bleed
// postmortem comment in console-prompt-spawn-failure.test.ts): the confirm gate must stay OPEN
// until the process dies, but later files must see the supervisor default again.
const savedAutoSupervise = process.env.OMP_SQUAD_AUTOSUPERVISE;
process.env.OMP_SQUAD_AUTOSUPERVISE = "0";
afterAll(() => {
	if (savedAutoSupervise === undefined) delete process.env.OMP_SQUAD_AUTOSUPERVISE;
	else process.env.OMP_SQUAD_AUTOSUPERVISE = savedAutoSupervise;
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Streams a thinking delta, an assistant delta, and an open tool call — then never resolves the
 *  turn, modeling a process killed mid-stream (the screenshot incident's shape). */
class DiesMidStreamDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;
	get isReady(): boolean { return this.ready; }
	get isAlive(): boolean { return this.alive; }
	async start(): Promise<void> { this.ready = true; this.alive = true; this.emit("ready"); }
	async stop(): Promise<void> { this.ready = false; this.alive = false; }
	prompt(): Promise<void> {
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "pondering" } });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "half an answ" } });
		this.emit("event", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "sleep 999" }, intent: "long tool" });
		this.emit("ui", { type: "extension_ui_request", method: "confirm", id: "gate-1", title: "proceed?", message: "may I?" } satisfies RpcExtensionUIRequest);
		return new Promise(() => {}); // the process dies before agent_end / tool_execution_end / any answer
	}
	async abort(): Promise<unknown> { return undefined; }
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: true } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

/** Completes its turn cleanly (agent_end settles everything to "ok") — the exit that follows is
 *  one-shot teardown, and the settle sweep must find nothing to touch. */
class CleanTurnDriver extends DiesMidStreamDriver {
	override prompt(): Promise<void> {
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
		this.emit("event", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {}, intent: "quick" });
		this.emit("event", { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { exitCode: 0 }, isError: false });
		this.emit("event", { type: "agent_end" });
		return Promise.resolve();
	}
}

interface DriverFactoryHost { makeDriver: (p: PersistedAgent) => AgentDriver; }

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string; stateDir: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	tmps.push(repo, stateDir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	return { mgr, repo, stateDir };
}

test("a crash mid-stream settles every running transcript entry to error — no phantom 'Working' outlives the process", async () => {
	const { mgr, repo, stateDir } = await makeMgr("settle-crash");
	const driver = new DiesMidStreamDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	// approvalMode "write", not "yolo": yolo's auto-supervisor may answer the confirm gate before
	// the exit lands, and this test needs the pending to still be open when the process dies.
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "write", autoRoute: false });

	const reEmitted: TranscriptEntry[] = [];
	mgr.on("event", (event: SquadEvent) => {
		if (event.type === "transcript" && event.entry.status !== "running") reEmitted.push(event.entry);
	});

	void mgr.applyCommand({ type: "prompt", id: dto.id, message: "go" } as never);
	await new Promise((r) => setTimeout(r, 10));
	// Preconditions — this IS the screenshot state: unit working, three entries claiming running,
	// and an unanswered pending request.
	expect(mgr.getTranscript(dto.id).filter((e) => e.status === "running").length).toBeGreaterThanOrEqual(3);
	expect(mgr.list().find((a) => a.id === dto.id)?.pending.length).toBe(1);

	driver.emit("exit", { code: 143 }); // SIGTERM mid-stream — the roster side flips to error…

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe("error");
	expect(after?.error).toContain("143");
	// A dead process can't receive an answer — the pending request must stop being answerable.
	expect(after?.pending).toEqual([]);
	// …and now the transcript side agrees: nothing is left running, the dead stream/tool entries are terminal.
	const transcript = mgr.getTranscript(dto.id);
	expect(transcript.filter((e) => e.status === "running")).toEqual([]);
	expect(transcript.find((e) => e.kind === "assistant")?.status).toBe("error");
	expect(transcript.find((e) => e.kind === "thinking")?.status).toBe("error");
	expect(transcript.find((e) => e.kind === "tool")?.status).toBe("error");
	// Each settle was re-emitted on the live channel (the in-place-mutate + re-emit contract a WS
	// subscriber and the runningFloor delta poller both rely on), with seq untouched.
	for (const kind of ["assistant", "thinking", "tool"]) {
		const settled = reEmitted.find((e) => e.kind === kind && e.status === "error");
		expect(settled).toBeDefined();
		expect(settled?.seq).toBe(transcript.find((e) => e.kind === kind)?.seq as number);
	}

	// The settle is persisted: a daemon restart must not resurrect "running" from state.json.
	await mgr.stop();
	const snapshot = await new FileStore(stateDir).load();
	expect((snapshot.transcripts[dto.id] ?? []).filter((e) => e.status === "running")).toEqual([]);
});

test("clean one-shot teardown (exit 143 after a completed turn) leaves the ok entries untouched", async () => {
	const { mgr, repo } = await makeMgr("settle-clean");
	const driver = new CleanTurnDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const dto = await mgr.create({ name: "one-shot", repo, approvalMode: "yolo", autoRoute: false, task: "do it" });

	driver.emit("exit", { code: 143 });

	expect(mgr.list().find((a) => a.id === dto.id)?.status).toBe("stopped");
	const statuses = mgr.getTranscript(dto.id).map((e) => e.status).filter(Boolean);
	expect(statuses.length).toBeGreaterThan(0);
	expect(statuses.every((s) => s === "ok")).toBe(true); // settle is a no-op sweep, never a clobber
	await mgr.stop();
});

test("operator kill settles running entries to cancelled and clears pending — even though RpcAgent.stop() suppresses its exit event", async () => {
	const { mgr, repo } = await makeMgr("settle-kill");
	const driver = new DiesMidStreamDriver(); // fake stop() emits no exit — models the RPC driver's suppression
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", autoRoute: false });
	void mgr.applyCommand({ type: "prompt", id: dto.id, message: "go" } as never);
	await new Promise((r) => setTimeout(r, 10));
	expect(mgr.getTranscript(dto.id).some((e) => e.status === "running")).toBe(true);

	await mgr.applyCommand({ type: "kill", id: dto.id } as never);

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe("stopped");
	expect(after?.pending).toEqual([]);
	const transcript = mgr.getTranscript(dto.id);
	expect(transcript.filter((e) => e.status === "running")).toEqual([]);
	// A deliberate kill interrupts work, it doesn't fail it: cancelled, never error.
	expect(transcript.find((e) => e.kind === "assistant")?.status).toBe("cancelled");
	expect(transcript.find((e) => e.kind === "tool")?.status).toBe("cancelled");
	await mgr.stop();
});

test("restart settles the outgoing turn's running entries, and the OLD driver's late exit can't touch the new turn (generation pin)", async () => {
	const { mgr, repo } = await makeMgr("settle-restart");
	const old = new DiesMidStreamDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => old;
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", autoRoute: false });
	void mgr.applyCommand({ type: "prompt", id: dto.id, message: "first" } as never);
	await new Promise((r) => setTimeout(r, 10));
	const oldRunning = mgr.getTranscript(dto.id).filter((e) => e.status === "running").map((e) => e.seq);
	expect(oldRunning.length).toBeGreaterThanOrEqual(3);

	const fresh = new DiesMidStreamDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => fresh;
	await mgr.applyCommand({ type: "restart", id: dto.id } as never);
	// The old turn settled at restart (stop() never emits exit for an RPC driver, so restart itself must do it).
	const afterRestart = mgr.getTranscript(dto.id);
	for (const seq of oldRunning) expect(afterRestart.find((e) => e.seq === seq)?.status).toBe("cancelled");

	// New turn starts streaming on the fresh driver…
	void mgr.applyCommand({ type: "prompt", id: dto.id, message: "second" } as never);
	await new Promise((r) => setTimeout(r, 10));
	const newRunning = mgr.getTranscript(dto.id).filter((e) => e.status === "running");
	expect(newRunning.length).toBeGreaterThanOrEqual(3);
	const statusBefore = mgr.list().find((a) => a.id === dto.id)?.status;

	// …and the superseded process finally reports its SIGTERM. Without the generation pin this would
	// stamp error on the healthy replacement and settle the NEW turn's entries mid-stream.
	old.emit("exit", { code: 143 });

	const after = mgr.list().find((a) => a.id === dto.id);
	expect(after?.status).toBe(statusBefore);
	expect(after?.error).toBeUndefined();
	for (const e of newRunning) expect(mgr.getTranscript(dto.id).find((x) => x.seq === e.seq)?.status).toBe("running");
	await mgr.stop();
});

test("buildDeadPlaceholder settles a recovered tail's running entries — a dead session's transcript never claims Working", () => {
	const p = { id: "x", name: "x", repo: "/r", worktree: "/w", harness: "claude-code" } as unknown as PersistedAgent;
	const tail = [
		{ seq: 1, kind: "user", text: "hi", ts: 1 },
		{ seq: 2, kind: "assistant", text: "half", ts: 2, status: "running" },
		{ seq: 3, kind: "tool", text: "▸ bash", ts: 3, status: "running" },
	] as TranscriptEntry[];
	const ph = buildDeadPlaceholder(p, tail, 50);
	expect(ph.transcript.filter((e) => e.status === "running")).toEqual([]);
	expect(ph.transcript.map((e) => e.status)).toEqual([undefined, "cancelled", "cancelled"]);
});
