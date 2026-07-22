import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState, SquadEvent } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class RichDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;
	get isReady(): boolean { return this.ready; }
	get isAlive(): boolean { return this.alive; }
	async start(): Promise<void> { this.ready = true; this.alive = true; this.emit("ready"); }
	async stop(): Promise<void> { this.ready = false; this.alive = false; }
	async prompt(): Promise<void> {
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "checking " } });
		this.emit("event", { type: "thinking_delta", delta: "state" });
		this.emit("event", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo hi" }, intent: "Checking" });
		this.emit("event", { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { stdout: "hi" } });
		this.emit("event", { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { stdout: "hi", exitCode: 0 }, isError: false });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
		this.emit("event", { type: "message_end", message: { role: "assistant" } });
		this.emit("event", { type: "agent_end" });
	}
	async abort(): Promise<unknown> { return undefined; }
	async getState(): Promise<RpcSessionState> {
		return { thinkingLevel: undefined, isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "s", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] };
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost { makeDriver: (p: PersistedAgent) => AgentDriver; }

test("manager preserves client turn ids and rich tool lifecycle in one transcript entry", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rich-transcript-repo-"));
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rich-transcript-state-"));
	tmps.push(repo, stateDir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new RichDriver();
	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo", autoRoute: false });
	const streamed: Array<{ kind: string; id?: string; status?: string; text: string }> = [];
	mgr.on("event", (event: SquadEvent) => {
		if (event.type === "transcript" && (event.entry.kind === "assistant" || event.entry.kind === "thinking")) streamed.push({ kind: event.entry.kind, id: event.entry.id, status: event.entry.status, text: event.entry.text });
	});
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "hello", clientTurnId: "turn-a" });

	const transcript = mgr.getTranscript(dto.id);
	expect(transcript.filter((e) => e.kind === "user" && e.clientTurnId === "turn-a")).toHaveLength(1);
	const tools = transcript.filter((e) => e.kind === "tool");
	expect(tools).toHaveLength(1);
	expect(tools[0]?.status).toBe("ok");
	expect(tools[0]?.tool?.name).toBe("bash");
	expect(tools[0]?.tool?.argsText).toContain("echo hi");
	expect(tools[0]?.tool?.resultText).toContain("exitCode");
	const assistants = transcript.filter((e) => e.kind === "assistant");
	expect(assistants).toHaveLength(1);
	expect(assistants[0]?.text).toBe("done");
	expect(assistants[0]?.status).toBe("ok");
	expect(streamed.filter((e) => e.kind === "assistant").map((e) => e.status)).toEqual(["running", "ok"]);
	expect(new Set(streamed.filter((e) => e.kind === "assistant").map((e) => e.id)).size).toBe(1);
	const thinking = transcript.filter((e) => e.kind === "thinking");
	expect(thinking).toHaveLength(1);
	expect(thinking[0]?.text).toBe("checking state");
	expect(thinking[0]?.status).toBe("ok");
	expect(streamed.filter((e) => e.kind === "thinking").map((e) => e.status)).toEqual(["running", "running", "ok"]);
	expect(new Set(streamed.filter((e) => e.kind === "thinking").map((e) => e.id)).size).toBe(1);
	await mgr.stop();
});

test("prompt keeps the full context-augmented message as the durable transcript text, alongside the clean displayText the user typed", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rich-transcript-repo-"));
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rich-transcript-state-"));
	tmps.push(repo, stateDir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	let receivedMessage: string | undefined;
	class EchoDriver extends RichDriver {
		override async prompt(message: string): Promise<void> {
			receivedMessage = message;
			await super.prompt(message);
		}
	}
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new EchoDriver();
	const dto = await mgr.create({ name: "chat-echo", repo, approvalMode: "yolo", autoRoute: false });
	const fullMessage = "what's up\n\n[Live context for reference — only act on it if asked]\nfleet snapshot...";
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: fullMessage, clientTurnId: "turn-b", displayText: "what's up" });

	const transcript = mgr.getTranscript(dto.id);
	const userEntries = transcript.filter((e) => e.kind === "user" && e.clientTurnId === "turn-b");
	expect(userEntries).toHaveLength(1);
	// The durable record is the FULL message the agent actually received — this is the
	// audit/debug trail ("why did the agent act on stale fleet data?").
	expect(userEntries[0]?.text).toBe(fullMessage);
	// The clean, user-typed text is preserved separately for the UI to render.
	expect(userEntries[0]?.displayText).toBe("what's up");
	expect(receivedMessage).toBe(fullMessage);

	// Persist + reload through the actual on-disk store round-trips both fields (the durable
	// text and the display-only text survive a daemon restart, not just an in-memory subscribe).
	await mgr.stop();
	const store = new FileStore(stateDir);
	const snapshot = await store.load();
	const persistedEntry = snapshot.transcripts[dto.id]?.find((e) => e.kind === "user" && e.clientTurnId === "turn-b");
	expect(persistedEntry?.text).toBe(fullMessage);
	expect(persistedEntry?.displayText).toBe("what's up");
});

test("prompt without displayText leaves it unset and the transcript text is the full message (older clients)", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rich-transcript-repo-"));
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rich-transcript-state-"));
	tmps.push(repo, stateDir);
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new RichDriver();
	const dto = await mgr.create({ name: "chat-legacy", repo, approvalMode: "yolo", autoRoute: false });
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "hello legacy", clientTurnId: "turn-c" });

	const transcript = mgr.getTranscript(dto.id);
	const userEntries = transcript.filter((e) => e.kind === "user" && e.clientTurnId === "turn-c");
	expect(userEntries).toHaveLength(1);
	expect(userEntries[0]?.text).toBe("hello legacy");
	expect(userEntries[0]?.displayText).toBeUndefined();
	await mgr.stop();
});

