/**
 * Epic 2 leaf 01 (execution-role dimension): `executionRole` is an orthogonal field on
 * `CreateAgentOptions` → `PersistedAgent` → `AgentDTO`, distinct from the RBAC `Role` and from
 * `AgentKind`. This is pure plumbing — a create() carrying the role round-trips it onto the DTO,
 * and an unset role stays undefined (no behavior keys off it yet).
 */

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
