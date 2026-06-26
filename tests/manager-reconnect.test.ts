import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class ReconnectDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;
	starts = 0;
	prompts: string[] = [];

	get isReady(): boolean { return this.ready; }
	get isAlive(): boolean { return this.alive; }

	async start(): Promise<void> {
		this.starts++;
		this.ready = true;
		this.alive = true;
		this.emit("ready");
	}
	async stop(): Promise<void> { this.alive = false; this.ready = false; }
	async prompt(message: string): Promise<void> {
		if (!this.alive) throw new Error("agent not connected");
		this.prompts.push(message);
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } });
		this.emit("event", { type: "message_end", message: { role: "assistant" } });
		this.emit("event", { type: "agent_end" });
	}
	async abort(): Promise<unknown> { return undefined; }
	async getState(): Promise<RpcSessionState> { return {} as RpcSessionState; }
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "reconnect-repo-"));
	tmps.push(repo);
	const git = async (args: string[]) => { await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited; };
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

test("prompt reconnects an idle driver instead of turning the agent red", async () => {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconnect-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "reconnect-wt-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	const driver = new ReconnectDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;

	const dto = await mgr.create({ name: "chat", repo, approvalMode: "yolo" });
	driver.alive = false;
	driver.ready = false;

	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "hello" });

	expect(driver.starts).toBe(2);
	expect(driver.prompts).toEqual(["hello"]);
	expect(mgr.getAgent(dto.id)?.status).toBe("idle");
	expect(mgr.getAgent(dto.id)?.error).toBeUndefined();

	await mgr.stop();
});
