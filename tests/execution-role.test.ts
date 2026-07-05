/**
 * Epic 2 leaf 01 (execution-role dimension): `executionRole` is an orthogonal field on
 * `CreateAgentOptions` → `PersistedAgent` → `AgentDTO`, distinct from the RBAC `Role` and from
 * `AgentKind`. This is pure plumbing — a create() carrying the role round-trips it onto the DTO,
 * and an unset role stays undefined (no behavior keys off it yet). The revival paths (reconnect,
 * terminal reattach, fork) must carry the role too, or a persisted tester/observer revives unlabeled.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";
import type { EngineCheckpoint, WorkflowRunState } from "../src/workflow/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface AttachHost {
	attachExisting: (p: PersistedAgent, transcript?: unknown[]) => Promise<void>;
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	checkpointAppending?: Promise<void>;
}
interface InternalHost {
	agents: Map<string, AgentRecordLike>;
}

const checkpoint = (over: Partial<EngineCheckpoint> = {}): EngineCheckpoint => ({ goal: "g", currentNode: "verify", visits: { verify: 1 }, vars: {}, index: 0, ...over });
const runState = (over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({ goal: "g", currentNode: "verify", visits: { verify: 1 }, vars: {}, index: 0, rollup: [], ...over });

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo };
}

test("create() with executionRole:\"observer\" round-trips onto the AgentDTO", async () => {
	const { mgr, repo } = await makeMgr("exec-role-observer");
	const dto = await mgr.create({ name: "obs", repo, approvalMode: "yolo", verify: "true", executionRole: "observer" });
	expect(dto.executionRole).toBe("observer");
	await mgr.stop();
});

test("create() with executionRole:\"tester\" round-trips onto the AgentDTO", async () => {
	const { mgr, repo } = await makeMgr("exec-role-tester");
	const dto = await mgr.create({ name: "test", repo, approvalMode: "yolo", verify: "true", executionRole: "tester" });
	expect(dto.executionRole).toBe("tester");
	await mgr.stop();
});

test("create() with no executionRole leaves the DTO field undefined (general coder, today's default)", async () => {
	const { mgr, repo } = await makeMgr("exec-role-unset");
	const dto = await mgr.create({ name: "plain", repo, approvalMode: "yolo", verify: "true" });
	expect(dto.executionRole).toBeUndefined();
	await mgr.stop();
});

// ── revival round-trips (SIG-1/SIG-2): the role must survive reconnect, terminal reattach, and fork ──

test("reconnect (attachExisting) carries executionRole onto the revived DTO and the next persisted snapshot", async () => {
	const { mgr } = await makeMgr("exec-role-reconnect");
	const stateDir = (mgr as unknown as { stateDir: string }).stateDir;
	const persisted: PersistedAgent = {
		id: "reconnect-observer",
		name: "obs",
		repo: "(none)",
		worktree: "(none)",
		approvalMode: "yolo",
		kind: "workflow",
		executionRole: "observer",
	};
	await (mgr as unknown as AttachHost).attachExisting(persisted, []);
	expect(mgr.getAgent(persisted.id)?.executionRole).toBe("observer");
	await mgr.stop(); // forces a persist()

	const raw = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as { agents: PersistedAgent[] };
	expect(raw.agents.find((a) => a.id === persisted.id)?.executionRole).toBe("observer");
});

test("terminal reattach (reattachTerminal via boot) carries executionRole onto the revived DTO", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-role-terminal-state-"));
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "exec-role-terminal-wt-"));
	tmps.push(stateDir, worktree);
	const persisted: PersistedAgent = {
		id: "terminal-tester",
		name: "tester",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		kind: "workflow",
		executionRole: "tester",
		workflow: { verify: { command: "true", mode: "tdd" } },
		// A terminal-marked run boots via reconnectLive → reattachTerminal (an inert record, no live driver).
		workflowState: { goal: "g", currentNode: "verify", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-terminal", terminal: { reason: "x", at: Date.now(), forkPoint: { runId: "run-terminal", seq: 0 } } },
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	await mgr.start();

	expect(mgr.getAgent(persisted.id)?.executionRole).toBe("tester");
	await mgr.stop();
});

test("fork carries executionRole from the source options onto the forked DTO", async () => {
	const { mgr, repo } = await makeMgr("exec-role-fork");
	const host = mgr as unknown as InternalHost;
	const dto = await mgr.create({ name: "src", repo, approvalMode: "yolo", verify: "true", executionRole: "tester" });
	expect(dto.executionRole).toBe("tester");
	const rec = host.agents.get(dto.id)!;
	const runId = "run-exec-role-fork";

	rec.agent.emit("checkpoint", runState({ runId, currentNode: "verify" }));
	await rec.checkpointAppending;
	rec.agent.emit("event", { type: "workflow_terminal", reason: "resume poison cap: escalated to a human", checkpoint: checkpoint({ resumeAttempts: 3 }) });
	await waitFor(() => rec.dto.status === "error");

	const forked = await mgr.fork(dto.id, {}, LOCAL_ACTOR);
	expect(forked.executionRole).toBe("tester"); // the fork inherits the source's role, not undefined
	await mgr.stop();
});
