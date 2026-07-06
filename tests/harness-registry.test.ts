/**
 * Harness-agnostic foundation (plans/harness-agnostic-drivers, concerns 01-04):
 * - registry resolution + legacy `runtime` migration (so a restart never respawns an ACP unit as omp)
 * - makeDriver selects the driver class from the harness protocol (omp-rpc → RpcAgent, acp → AcpAgentDriver)
 * - binary/config: pi rides the RpcAgent transport with a bin swap; GLANCE_BIN overrides the default harness
 * - capability gating at create(): a no-approval harness (pi) rejects non-yolo; sandbox × non-omp rejected
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { RpcAgent } from "../src/rpc-agent.ts";
import { AcpAgentDriver } from "../src/acp-agent-driver.ts";
import { SandboxAgentDriver } from "../src/sandbox-agent-driver.ts";
import {
	DEFAULT_HARNESS,
	getHarness,
	globalDefaultHarness,
	listHarnesses,
	resolveBin,
	resolveHarness,
	resolveHarnessName,
	runtimeToHarness,
} from "../src/harness-registry.ts";
import type { PersistedAgent } from "../src/types.ts";

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

// ── registry resolution + migration ──────────────────────────────────────────

test("runtimeToHarness maps the legacy runtime field; unknown/absent → undefined", () => {
	expect(runtimeToHarness("omp")).toBe("omp");
	expect(runtimeToHarness("acp")).toBe("auggie"); // the only harness legacy runtime:"acp" could mean
	expect(runtimeToHarness(undefined)).toBeUndefined();
});

test("resolveHarnessName: explicit harness > legacy runtime > global default", () => {
	stashEnv("GLANCE_HARNESS");
	delete process.env.GLANCE_HARNESS;
	expect(resolveHarnessName({ harness: "pi" })).toBe("pi");
	expect(resolveHarnessName({ runtime: "acp" })).toBe("auggie"); // migration
	expect(resolveHarnessName({})).toBe(DEFAULT_HARNESS); // "omp"
	process.env.GLANCE_HARNESS = "pi";
	expect(resolveHarnessName({})).toBe("pi"); // env default
	expect(resolveHarnessName({ harness: "omp" })).toBe("omp"); // explicit still wins
});

test("resolveHarness throws loudly on an unknown harness (never silently falls back to omp)", () => {
	expect(() => resolveHarness({ harness: "does-not-exist" })).toThrow(/unknown harness/);
});

test("resolveBin: per-agent override > GLANCE_BIN (default harness only) > descriptor bin", () => {
	stashEnv("GLANCE_BIN", "GLANCE_HARNESS");
	delete process.env.GLANCE_HARNESS;
	const omp = getHarness("omp")!;
	const pi = getHarness("pi")!;
	expect(resolveBin(omp)).toBe("omp");
	expect(resolveBin(pi)).toBe("pi");
	expect(resolveBin(omp, "/custom/omp")).toBe("/custom/omp"); // per-agent override
	process.env.GLANCE_BIN = "/opt/omp-fork";
	expect(resolveBin(omp)).toBe("/opt/omp-fork"); // GLANCE_BIN overrides the DEFAULT harness
	expect(resolveBin(pi)).toBe("pi"); // …but NOT a non-default harness
});

test("pi's approval dialect is --no-approve (not omp's --approval-mode); omp keeps --approval-mode", () => {
	expect(getHarness("omp")!.approvalArgs!("yolo")).toEqual(["--approval-mode", "yolo"]);
	expect(getHarness("pi")!.approvalArgs!("yolo")).toEqual([]); // pi v0.56.3 has no approval flag (verified)
	expect(getHarness("omp")!.leaseHook).toBe(true);
	expect(getHarness("pi")!.leaseHook).toBe(false); // pi runs without soft-leasing (documented)
});

test("listHarnesses hides unverified harnesses unless OMP_SQUAD_UNVERIFIED_HARNESS=1", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	const visible = listHarnesses().map((d) => d.name);
	expect(visible).toEqual(expect.arrayContaining(["omp", "pi", "opencode"])); // live-verified
	expect(visible).not.toContain("gemini"); // unverified (binary absent) — hidden
	expect(visible).not.toContain("codex");
	expect(visible).not.toContain("claude-code");
	const all = listHarnesses(true).map((d) => d.name);
	expect(all).toEqual(expect.arrayContaining(["omp", "pi", "gemini", "opencode", "claude-code", "codex", "auggie"]));
});

test("capability descriptors: pi has no host-tools/approval; ACP harnesses are non-resumable, no context injection", () => {
	const pi = getHarness("pi")!.capabilities;
	expect(pi.hostTools).toBe(false);
	expect(pi.toolApproval).toBe("none");
	expect(pi.resumable).toBe(true); // pi rides the same detached agent-host as omp
	const gemini = getHarness("gemini")!.capabilities;
	expect(gemini.resumable).toBe(false); // direct ACP spawn — no reattach (concern 07)
	expect(gemini.contextInjection).toBe("none"); // ACP has no system-prompt slot (concern 06)
	expect(gemini.hostTools).toBe(false);
});

// ── makeDriver selection (real makeDriver, no spawn — start() is what spawns) ──

function mgrFor(stateDir: string): SquadManager {
	return new SquadManager({ stateDir, skipGlobalJanitors: true });
}

function persisted(over: Partial<PersistedAgent>): PersistedAgent {
	return { id: "d", name: "d", repo: "/r", worktree: "/w", approvalMode: "yolo", kind: "omp-operator", ...over };
}

test("makeDriver selects the driver class from the harness protocol", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-md-"));
	tmps.push(stateDir);
	const mgr = mgrFor(stateDir);
	const make = (p: PersistedAgent) => (mgr as unknown as { makeDriver: (p: PersistedAgent) => unknown }).makeDriver(p);

	// default (no harness/runtime) → omp RpcAgent
	const omp = make(persisted({})) as RpcAgent;
	expect(omp).toBeInstanceOf(RpcAgent);
	expect((omp as unknown as { opts: { bin?: string; harness?: string } }).opts.bin).toBe("omp");
	expect((omp as unknown as { opts: { harness?: string } }).opts.harness).toBe("omp");

	// pi → RpcAgent with the pi binary + harness threaded (so the host builds --no-approve)
	const pi = make(persisted({ harness: "pi" })) as RpcAgent;
	expect(pi).toBeInstanceOf(RpcAgent);
	expect((pi as unknown as { opts: { bin?: string; harness?: string } }).opts.bin).toBe("pi");
	expect((pi as unknown as { opts: { harness?: string } }).opts.harness).toBe("pi");

	// gemini (acp) → AcpAgentDriver
	expect(make(persisted({ harness: "gemini" }))).toBeInstanceOf(AcpAgentDriver);

	// MIGRATION: legacy runtime:"acp" with no harness → AcpAgentDriver (NOT respawned as omp)
	expect(make(persisted({ runtime: "acp" }))).toBeInstanceOf(AcpAgentDriver);

	// sandbox → SandboxAgentDriver (omp-only path)
	expect(make(persisted({ sandbox: { image: "alpine", workdir: "/w" } }))).toBeInstanceOf(SandboxAgentDriver);

	await mgr.stop();
});

// ── capability gating at create() (throws BEFORE cutting a worktree / spawning) ──

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "harness-repo-"));
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

test("create() refuses an unverified harness unless OMP_SQUAD_UNVERIFIED_HARNESS=1", async () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-unver-"));
	tmps.push(stateDir);
	const repo = await makeRepo();
	const mgr = mgrFor(stateDir);
	// gemini's binary isn't installed here, so it stays unverified — the honest gate refuses it.
	await expect(mgr.create({ name: "u", repo, harness: "gemini", approvalMode: "yolo", autoRoute: false })).rejects.toThrow(/unverified/);
	await mgr.stop();
});

test("create() rejects a no-approval harness (pi) under a non-yolo approvalMode", async () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	process.env.OMP_SQUAD_UNVERIFIED_HARNESS = "1"; // opt past the unverified gate to reach the approval gate
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-gate-"));
	tmps.push(stateDir);
	const repo = await makeRepo();
	const mgr = mgrFor(stateDir);
	await expect(mgr.create({ name: "p", repo, harness: "pi", approvalMode: "always-ask", autoRoute: false })).rejects.toThrow(/no approval channel/);
	await mgr.stop();
});

test("create() rejects sandbox on a non-omp harness (sandbox×non-omp is unbuildable today)", async () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	process.env.OMP_SQUAD_UNVERIFIED_HARNESS = "1";
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-sandbox-"));
	tmps.push(stateDir);
	const repo = await makeRepo();
	const mgr = mgrFor(stateDir);
	await expect(mgr.create({ name: "g", repo, harness: "gemini", approvalMode: "yolo", sandbox: { image: "alpine", workdir: "/w" }, autoRoute: false })).rejects.toThrow(/cannot run sandboxed/);
	await mgr.stop();
});

test("globalDefaultHarness honors GLANCE_HARNESS, else omp", () => {
	stashEnv("GLANCE_HARNESS");
	delete process.env.GLANCE_HARNESS;
	expect(globalDefaultHarness()).toBe("omp");
	process.env.GLANCE_HARNESS = "claude-code";
	expect(globalDefaultHarness()).toBe("claude-code");
});
