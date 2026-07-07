/**
 * plans/agent-profiles concern 01 (elevate-profile-bundle): an AgentProfile is a full capability
 * bundle {harness, bin, model, thinking, skills, persona, approval} applied at create(), loadable
 * from env (OMP_SQUAD_PROFILES, fully trusted) and a shareable project catalog
 * (`.glance/profiles.json`, sanitized — repo-sourced input can't set `bin` or an unverified `harness`,
 * since `bin` flows unchecked to `Bun.spawn` and an unverified harness bypasses the honest-gating
 * concern 08 relies on everywhere else).
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { loadRepoProfiles, SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function stashEnv(...keys: string[]): void {
	for (const k of keys) savedEnv[k] = process.env[k];
}
afterEach(async () => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(savedEnv)) delete savedEnv[k];
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
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
interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
}
interface InternalHost {
	agents: Map<string, AgentRecordLike>;
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

async function writeRepoProfiles(repo: string, profiles: unknown[]): Promise<void> {
	const dir = path.join(repo, ".glance");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "profiles.json"), JSON.stringify(profiles));
}

// ── env profile → harness/bin flows through create() ─────────────────────────

test("env profile with harness applies to a created unit (dto.harness + ACP capabilities)", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "acp-profile", name: "ACP profile", harness: "opencode" }]);
	const { mgr, repo } = await makeMgr("profile-harness");
	const dto = await mgr.create({ name: "u", repo, profileId: "acp-profile", approvalMode: "yolo", autoRoute: false });
	expect(dto.harness).toBe("opencode");
	// harnessCaps is stamped from the resolved descriptor's capabilities — opencode is ACP, so this
	// proves resolveHarness actually landed on the ACP descriptor, not just echoed the profile's string.
	expect(dto.harnessCaps?.hostTools).toBe(false);
	expect(dto.harnessCaps?.resumable).toBe(false);
	await mgr.stop();
});

test("env profile with bin is honored (persisted.bin round-trips through the profile merge)", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "pi-custom", name: "Custom pi", harness: "pi", bin: "/custom/pi" }]);
	const { mgr, repo } = await makeMgr("profile-bin");
	const dto = await mgr.create({ name: "u", repo, profileId: "pi-custom", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.options.bin).toBe("/custom/pi");
	expect(rec.options.harness).toBe("pi");
	await mgr.stop();
});

test("explicit opts.bin/opts.harness win over the profile's default (opts ?? profile ordering)", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "pi-custom", name: "Custom pi", harness: "pi", bin: "/custom/pi" }]);
	const { mgr, repo } = await makeMgr("profile-override");
	const dto = await mgr.create({ name: "u", repo, profileId: "pi-custom", harness: "omp", approvalMode: "yolo", autoRoute: false });
	expect(dto.harness).toBe("omp"); // explicit opts.harness beat the profile's "pi"
	await mgr.stop();
});

// ── repo catalog sanitization (security) ──────────────────────────────────────

test("loadRepoProfiles drops `bin` from a repo-sourced profile and warns", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "repo-catalog-bin-"));
	tmps.push(repo);
	await writeRepoProfiles(repo, [{ id: "sneaky", name: "Sneaky", harness: "pi", bin: "/tmp/evil" }]);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const profiles = loadRepoProfiles(repo);
		expect(profiles).toHaveLength(1);
		expect(profiles[0]!.bin).toBeUndefined();
		expect(profiles[0]!.harness).toBe("pi"); // pi is verified, so the harness itself is kept
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toContain("bin");
	} finally {
		warn.mockRestore();
	}
});

test("loadRepoProfiles rejects an unverified/unknown harness from a repo-sourced profile and warns", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "repo-catalog-harness-"));
	tmps.push(repo);
	await writeRepoProfiles(repo, [{ id: "bad-harness", name: "Bad harness", harness: "codex" }]); // codex: registered but verified:false
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const profiles = loadRepoProfiles(repo);
		expect(profiles).toHaveLength(1);
		expect(profiles[0]!.harness).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]![0]).toContain("codex");
	} finally {
		warn.mockRestore();
	}
});

test("loadRepoProfiles tolerates a missing .glance/profiles.json (empty array, no throw)", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "repo-catalog-missing-"));
	tmps.push(repo);
	expect(loadRepoProfiles(repo)).toEqual([]);
});

test("a repo profile's dropped bin/rejected harness stay dropped end-to-end through create()", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	delete process.env.OMP_SQUAD_PROFILES;
	const { mgr, repo } = await makeMgr("profile-repo-e2e");
	// pi is a verified harness, so it survives sanitization — but `bin` never should, no matter which
	// harness is picked.
	await writeRepoProfiles(repo, [{ id: "repo-pi", name: "Repo pi", harness: "pi", bin: "/tmp/evil" }]);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	let dto: AgentDTO;
	try {
		dto = await mgr.create({ name: "u", repo, profileId: "repo-pi", approvalMode: "yolo", autoRoute: false });
	} finally {
		warn.mockRestore();
	}
	expect(dto.harness).toBe("pi");
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.options.bin).toBeUndefined(); // never reached Bun.spawn despite the repo file asking for it
	await mgr.stop();
});

// ── loud capability gate: profile thinking vs a thinking:false harness ───────

test("a profile's thinking on a thinking:false (ACP) harness rejects loudly at create(), not a silent drop", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "acp-thinking", name: "ACP thinking", harness: "opencode", thinking: "high" }]);
	const { mgr, repo } = await makeMgr("profile-thinking-gate");
	await expect(mgr.create({ name: "u", repo, profileId: "acp-thinking", approvalMode: "yolo", autoRoute: false })).rejects.toThrow(/thinking/);
	await mgr.stop();
});

test("a profile's thinking on a thinking:true (omp) harness is unaffected", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "omp-thinking", name: "omp thinking", harness: "omp", thinking: "high" }]);
	const { mgr, repo } = await makeMgr("profile-thinking-ok");
	const dto = await mgr.create({ name: "u", repo, profileId: "omp-thinking", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.options.thinking).toBe("high");
	await mgr.stop();
});

// ── merge order: repo catalog (base) ← env (override by id) ← capability profiles ──

test("profiles(repo) merges the repo catalog as base, overridden by an env profile of the same id", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "profile-merge-"));
	tmps.push(repo);
	await writeRepoProfiles(repo, [
		{ id: "shared", name: "Repo shared", model: "repo-model" },
		{ id: "repo-only", name: "Repo only", model: "repo-model" },
	]);
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "shared", name: "Env shared", model: "env-model" }]);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-merge-state-"));
	tmps.push(stateDir);
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	const profiles = mgr.profiles(repo);
	const shared = profiles.find((p) => p.id === "shared");
	const repoOnly = profiles.find((p) => p.id === "repo-only");
	expect(profiles.filter((p) => p.id === "shared")).toHaveLength(1); // no duplicate — env wins by id
	expect(shared?.model).toBe("env-model"); // env overrides the repo catalog
	expect(repoOnly?.model).toBe("repo-model"); // repo-only entries pass through untouched
	await mgr.stop();
});

test("profiles() with no repo arg keeps today's env+capability-only behavior (repo-less callers)", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "env-only", name: "Env only" }]);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-norepo-state-"));
	tmps.push(stateDir);
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	expect(mgr.profiles().map((p) => p.id)).toEqual(["env-only"]);
	await mgr.stop();
});
