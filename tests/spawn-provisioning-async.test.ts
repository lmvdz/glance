/**
 * Spawn-time provisioning stays OFF the dispatcher's critical path (cross-lineage review HIGH 1)
 * and is scoped to host-side coding-agent kinds only (MEDIUM 5).
 *
 * Dispatcher.tick serially awaits each spawn — when createWithId awaited provisionWorktreeDeps
 * inline, one tick could stall minutes on cold installs (worst case: N issues × 2 packages ×
 * 120s timeout each). The invariant is "the verify gate must not run before provisioning
 * settles", NOT "the dispatch tick must wait": createWithId kicks the install as a promise in
 * `this.provisioning` and makeDriver's workflow execCommand awaits it before the first gate.
 *
 * Scope: sandbox spawns skip provisioning (the container is its own platform — host-built
 * node_modules can be platform-wrong inside the mount) and flue-service spawns skip it (their
 * driver runs from p.flue.dir, not the repo worktree; commission()'s installWorker owns that
 * dir). Plain and workflow units — the kinds that run the verify gate on the host — provision.
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

class NoopDriver extends EventEmitter implements AgentDriver {
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

interface ProvisioningHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
	spawnDepsInstaller: (cwd: string) => Promise<void>;
	provisioning: Map<string, Promise<void>>;
}

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-prov-repo-"));
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

async function makeManager(): Promise<SquadManager> {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-prov-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-prov-wt-"));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as ProvisioningHost).makeDriver = () => new NoopDriver();
	return mgr;
}

test("two spawns with slow installs complete without waiting for either install (HIGH 1: off the tick path)", async () => {
	const mgr = await makeManager();
	const host = mgr as unknown as ProvisioningHost;
	let installs = 0;
	const settled: Array<() => void> = [];
	host.spawnDepsInstaller = () => {
		installs++;
		return new Promise<void>((resolve) => settled.push(resolve)); // never resolves until WE say so — an infinitely-cold install
	};
	const repo = await makeRepo();

	const t0 = Date.now();
	// Dispatcher.tick's spawn calls are exactly these awaits, in series — the pre-fix code would
	// hang here forever (installs never settle); post-fix both return immediately.
	const a = await mgr.create({ name: "unit-a", repo, approvalMode: "yolo" });
	const b = await mgr.create({ name: "unit-b", repo, approvalMode: "yolo" });
	const elapsed = Date.now() - t0;

	expect(installs).toBe(2); // both kicked
	expect(settled.length).toBe(2); // both still pending — creation never awaited them
	expect(elapsed).toBeLessThan(10_000); // git worktree ops only; nowhere near an install timeout
	expect(host.provisioning.get(a.id)).toBeDefined(); // awaitable by the gate path
	expect(host.provisioning.get(b.id)).toBeDefined();

	for (const r of settled) r(); // settle the fake installs
	await Promise.all([host.provisioning.get(a.id), host.provisioning.get(b.id)]);
	// Self-cleaning: settled entries leave the map (awaiting a missing entry is a no-op).
	await new Promise((r) => setTimeout(r, 10));
	expect(host.provisioning.size).toBe(0);
	await mgr.stop();
}, 30_000);

test("sandbox spawns skip provisioning — the container is its own platform (MEDIUM 5)", async () => {
	const mgr = await makeManager();
	const host = mgr as unknown as ProvisioningHost;
	let installs = 0;
	host.spawnDepsInstaller = async () => {
		installs++;
	};
	const repo = await makeRepo();
	const dto = await mgr.create({ name: "boxed", repo, approvalMode: "yolo", sandbox: { image: "fake-image" } });
	expect(dto.id).toBeDefined();
	expect(installs).toBe(0);
	expect(host.provisioning.size).toBe(0);
	await mgr.stop();
}, 30_000);

test("flue-service spawns skip provisioning — their driver runs from flue.dir, not the worktree (MEDIUM 5)", async () => {
	const mgr = await makeManager();
	const host = mgr as unknown as ProvisioningHost;
	let installs = 0;
	host.spawnDepsInstaller = async () => {
		installs++;
	};
	const repo = await makeRepo();
	const flueDir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-prov-flue-"));
	tmps.push(flueDir);
	const dto = await mgr.create({ name: "worker", repo, approvalMode: "yolo", flue: { dir: flueDir, workflow: "noop", target: "node" } });
	expect(dto.kind).toBe("flue-service");
	expect(installs).toBe(0);
	expect(host.provisioning.size).toBe(0);
	await mgr.stop();
}, 30_000);
