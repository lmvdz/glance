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
import { EventEmitter } from "node:events";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { RpcAgent } from "../src/rpc-agent.ts";
import { AcpAgentDriver } from "../src/acp-agent-driver.ts";
import { SandboxAgentDriver } from "../src/sandbox-agent-driver.ts";
import {
	_resetHarnessTierCacheForTests,
	DEFAULT_HARNESS,
	getHarness,
	globalDefaultHarness,
	harnessTierInfo,
	hasSecondVerifiedProviderLane,
	listHarnesses,
	listHarnessTiers,
	registerHarness,
	resolveBin,
	resolveHarness,
	resolveHarnessName,
	resolveSpawnBin,
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

// ── cold restore/adopt preserves the harness (audit fix) ─────────────────────

class NoopDriver extends EventEmitter {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> { return Promise.resolve(); }
	stop(): Promise<void> { return Promise.resolve(); }
	prompt(): Promise<void> { return Promise.resolve(); }
	abort(): Promise<unknown> { return Promise.resolve(); }
	getState(): Promise<unknown> { return Promise.resolve({ todoPhases: [], isStreaming: false }); }
	respondUi(): void {}
	respondHostTool(): void {}
}

async function makeDirtyWorktree(): Promise<string> {
	const wt = await fs.mkdtemp(path.join(os.tmpdir(), "harness-wt-"));
	tmps.push(wt);
	const git = async (a: string[]) => { await Bun.spawn(["git", ...a], { cwd: wt, stdout: "ignore", stderr: "ignore" }).exited; };
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(wt, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	await fs.writeFile(path.join(wt, "wip.txt"), "unlanded\n"); // dirty ⇒ has work ⇒ adopted
	return wt;
}

test("cold-adopting a pi record keeps harness=pi (does NOT revert to omp)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-adopt-"));
	tmps.push(stateDir);
	const worktree = await makeDirtyWorktree();
	await new FileStore(stateDir).save({
		agents: [{ id: "orphan-pi", name: "pi-unit", repo: worktree, worktree, approvalMode: "yolo", kind: "omp-operator", harness: "pi" }],
		transcripts: {},
		features: [],
	});
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as { makeDriver: () => unknown }).makeDriver = () => new NoopDriver();
	await mgr.start();
	const dto = mgr.list()[0];
	expect(dto).toBeDefined();
	expect(dto!.id).not.toBe("orphan-pi"); // fresh id on adoption
	expect(dto!.harness).toBe("pi"); // harness lineage preserved through the cold-adopt create()
	await mgr.stop();
});

test("a non-resumable ACP record is excluded from adoption (concern 07)", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-adopt-acp-"));
	tmps.push(stateDir);
	const worktree = await makeDirtyWorktree();
	await new FileStore(stateDir).save({
		// legacy runtime:"acp" (→ auggie, resumable:false) — should be skipped, not respawned.
		agents: [{ id: "orphan-acp", name: "acp-unit", repo: worktree, worktree, approvalMode: "yolo", kind: "omp-operator", runtime: "acp" }],
		transcripts: {},
		features: [],
	});
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as { makeDriver: () => unknown }).makeDriver = () => new NoopDriver();
	await mgr.start();
	expect(mgr.list().length).toBe(0); // excluded — ACP is non-resumable
	await mgr.stop();
});

// ── degradation ladder precondition (concern 06) ──────────────────────────────

/** Temporarily override one registry entry (e.g. flip `verified`) and ALWAYS restore the original
 *  descriptor — the registry is module-global, so a leaked override would poison sibling tests. */
function withHarnessOverride<T>(name: string, over: Partial<Parameters<typeof registerHarness>[0]>, fn: () => T): T {
	const original = getHarness(name);
	if (!original) throw new Error(`no registered harness "${name}" to override`);
	registerHarness({ ...original, ...over, name });
	try {
		return fn();
	} finally {
		registerHarness(original);
	}
}

test("hasSecondVerifiedProviderLane: false today — the only vendor-pinned harnesses (claude-code/gemini/codex) are unverified", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	// omp (default), pi, opencode are all verified but multi-model (unknown lineage) — no differentiation.
	expect(hasSecondVerifiedProviderLane("omp")).toBe(false);
});

test("hasSecondVerifiedProviderLane: OMP_SQUAD_UNVERIFIED_HARNESS=1 does NOT fabricate a lane (verified-only contract)", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	process.env.OMP_SQUAD_UNVERIFIED_HARNESS = "1"; // surfaces unverified harnesses on create UIs...
	// ...but an unsmoked codex/gemini/claude-code registration is NOT a real second subscription lane:
	// telling the dispatcher otherwise would trade the fleet-safety freeze for a lane that half-works.
	expect(hasSecondVerifiedProviderLane("omp")).toBe(false);
});

test("hasSecondVerifiedProviderLane: true once a vendor-pinned harness is actually verified and differs from the default", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	// Simulate claude-code having passed a live smoke (verified:true) — registry override, restored after.
	withHarnessOverride("claude-code", { verified: true }, () => {
		expect(hasSecondVerifiedProviderLane("omp")).toBe(true); // anthropic-pinned lane, distinct from omp's unknown
	});
	expect(hasSecondVerifiedProviderLane("omp")).toBe(false); // override restored — back to reality
});

test("hasSecondVerifiedProviderLane: a vendor-pinned DEFAULT harness needs a genuinely different vendor to count", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	withHarnessOverride("claude-code", { verified: true }, () => {
		// default = claude-code (anthropic); the only other verified vendor-pinned harness is itself ⇒ false.
		expect(hasSecondVerifiedProviderLane("claude-code")).toBe(false);
		// A verified GOOGLE lane appears ⇒ genuinely different vendor ⇒ true.
		withHarnessOverride("gemini", { verified: true }, () => {
			expect(hasSecondVerifiedProviderLane("claude-code")).toBe(true);
		});
	});
});

// ── honesty tiers (concern 06) ────────────────────────────────────────────────

test("harnessTierInfo truth table: verified×detected 2×2 including the verified-binary-missing alert cell", () => {
	// omp: verified:true, binary IS on this repo's node_modules/.bin — verified, no alert.
	const omp = harnessTierInfo(getHarness("omp")!);
	expect(omp.tier).toBe("verified");
	expect(omp.verified).toBe(true);
	expect(omp.binDetected).toBe(true);
	expect(omp.alert).toBeUndefined();

	// gemini: verified:false, binary absent — registered-unverified, no alert (alert is verified-only).
	const gemini = harnessTierInfo(getHarness("gemini")!);
	expect(gemini.tier).toBe("registered-unverified");
	expect(gemini.verified).toBe(false);
	expect(gemini.binDetected).toBe(false);
	expect(gemini.alert).toBeUndefined();

	// detected-unverified: verified:false but the binary happens to resolve (e.g. `bun` is always present).
	withHarnessOverride("gemini", { verified: false, bin: "bun", acpCommand: ["bun", "--acp"] }, () => {
		const detected = harnessTierInfo(getHarness("gemini")!);
		expect(detected.tier).toBe("detected-unverified");
		expect(detected.binDetected).toBe(true);
	});

	// the alert cell: verified:true but the binary can't be resolved — a verified harness that will
	// actually fail to spawn, surfaced loudly instead of reading as a clean "verified" row.
	withHarnessOverride("gemini", { verified: true, bin: "definitely-not-a-real-binary-xyz", acpCommand: ["definitely-not-a-real-binary-xyz", "--acp"] }, () => {
		const missing = harnessTierInfo(getHarness("gemini")!);
		expect(missing.tier).toBe("verified");
		expect(missing.binDetected).toBe(false);
		expect(missing.alert).toMatch(/not found on the daemon PATH/);
	});
});

test("resolveSpawnBin: acp harnesses resolve their acpCommand[0] (e.g. npx), never the bare descriptor bin unconditionally for a differently-shelled adapter", () => {
	expect(resolveSpawnBin(getHarness("omp")!)).toBe("omp"); // omp-rpc → resolveBin
	expect(resolveSpawnBin(getHarness("codex")!)).toBe("npx"); // acp, npx-shelled — real launch argv[0]
	expect(resolveSpawnBin(getHarness("opencode")!)).toBe("opencode"); // acp, direct binary
});

test("npx-shelled acp adapters (codex/claude-code) get a weak-signal note on their tier row", () => {
	const codex = harnessTierInfo(getHarness("codex")!);
	expect(codex.note).toMatch(/weak signal/);
});

test("usageVerified: omp/pi are true (native RPC usage frame); ACP harnesses default false (ACP parseUsage unconfirmed)", () => {
	expect(harnessTierInfo(getHarness("omp")!).usageVerified).toBe(true);
	expect(harnessTierInfo(getHarness("pi")!).usageVerified).toBe(true);
	expect(harnessTierInfo(getHarness("gemini")!).usageVerified).toBe(false);
	expect(harnessTierInfo(getHarness("opencode")!).usageVerified).toBe(false);
});

test("listHarnessTiers covers every REGISTERED harness (not just the verified/create-visible subset)", () => {
	_resetHarnessTierCacheForTests();
	const names = listHarnessTiers().map((t) => t.name);
	expect(names).toEqual(expect.arrayContaining(["omp", "pi", "opencode", "gemini", "auggie", "claude-code", "codex"]));
});

test("listHarnessTiers caches briefly: a registry override made between two calls within the TTL is not reflected", () => {
	_resetHarnessTierCacheForTests();
	const first = listHarnessTiers().find((t) => t.name === "gemini")!;
	expect(first.tier).toBe("registered-unverified");
	withHarnessOverride("gemini", { verified: true }, () => {
		const second = listHarnessTiers().find((t) => t.name === "gemini")!;
		expect(second.tier).toBe("registered-unverified"); // cache still holds the pre-override snapshot
		_resetHarnessTierCacheForTests();
		const third = listHarnessTiers().find((t) => t.name === "gemini")!;
		expect(third.tier).toBe("verified"); // cache dropped — fresh detection sees the override
	});
	_resetHarnessTierCacheForTests();
});

test("gate byte-identity: listHarnesses/hasSecondVerifiedProviderLane read only `verified`, unaffected by tier machinery", () => {
	// Same assertions as the pre-existing gate tests above, re-run after tier computation has run —
	// proves harnessTierInfo/listHarnessTiers never mutate descriptors or the `verified` gate's inputs.
	_resetHarnessTierCacheForTests();
	listHarnessTiers(); // exercise tier computation first
	const visible = listHarnesses().map((d) => d.name);
	expect(visible).toEqual(expect.arrayContaining(["omp", "pi", "opencode"]));
	expect(visible).not.toContain("gemini");
	expect(hasSecondVerifiedProviderLane("omp")).toBe(false);
});

test("globalDefaultHarness honors GLANCE_HARNESS, else omp", () => {
	stashEnv("GLANCE_HARNESS");
	delete process.env.GLANCE_HARNESS;
	expect(globalDefaultHarness()).toBe("omp");
	process.env.GLANCE_HARNESS = "claude-code";
	expect(globalDefaultHarness()).toBe("claude-code");
});
