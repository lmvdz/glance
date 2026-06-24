/**
 * OMPSQ-163: create() must tear down a driver whose start() throws. ACP children and sandbox
 * containers have no reaper, so a failed-start leak persists until daemon exit. The fix: create()'s
 * catch calls `agent.stop()` when start() (not a later prompt) threw. This test injects a fake driver
 * whose start() rejects and asserts stop() was called exactly once, and the agent ends in `error`.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FailStartDriver extends EventEmitter implements AgentDriver {
	stopped = 0;
	readonly isReady = false;
	readonly isAlive = false;
	async start(): Promise<void> {
		// Models ACP: child already spawned, then the handshake rejects.
		throw new Error("handshake timeout");
	}
	async stop(): Promise<void> {
		this.stopped++;
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): never {
		throw new Error("unused in failed-start path");
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

// SquadManager.makeDriver is private; the test substitutes it at the instance level (shadows the
// prototype method) to inject a driver that fails start(). Named-const cast with a documented reason
// — there is no public injection seam and the runtime call (`this.makeDriver(...)`) honors the shadow.
interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ftd-repo-"));
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

test("create(): a driver whose start() throws is torn down (stop() called), agent ends in error", async () => {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	const repo = await makeRepo();
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ftd-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "ftd-wt-"));
	tmps.push(stateDir, worktreeBase);

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();

	const driver = new FailStartDriver();
	const host: DriverFactoryHost = mgr as unknown as DriverFactoryHost;
	host.makeDriver = () => driver;

	const dto = await mgr.create({ name: "leaky", repo, approvalMode: "yolo" });

	expect(dto.status).toBe("error");
	expect(driver.stopped).toBe(1); // backing process/container reaped, not leaked
	// The worktree created before start() failed must be reaped too, not orphaned in the base —
	// the gate ran this test every cycle and each leak orphaned a "squad-leaky" worktree (500+).
	expect(await fs.readdir(worktreeBase)).toEqual([]);

	await mgr.stop();
});
