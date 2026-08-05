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
	harnessAcceptsModel,
	harnessTierInfo,
	hasSecondVerifiedProviderLane,
	listHarnesses,
	listHarnessTiers,
	nearestCompatibleModel,
	registerHarness,
	resolveAcpCommand,
	resolveBin,
	resolveHarness,
	resolveHarnessName,
	resolveSpawnBin,
	runtimeToHarness,
} from "../src/harness-registry.ts";
import { harnessLineage } from "../src/model-lineage.ts";
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
	expect(visible).toEqual(expect.arrayContaining(["omp", "pi", "opencode", "claude-code", "codex"])); // live-verified (claude-code: 2026-07-16 smoke, daily-onramp 02; codex: 2026-08-04 smoke, ticket #336)
	expect(visible).not.toContain("gemini"); // unverified (binary absent) — hidden
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

// ── harness↔model-family compatibility (ticket #347) ─────────────────────────

test("harnessAcceptsModel: codex (openai-pinned) refuses an anthropic-family literal", () => {
	const codex = getHarness("codex")!;
	expect(harnessAcceptsModel(codex, "opus")).toBe(false);
	expect(harnessAcceptsModel(codex, "sonnet")).toBe(false);
	expect(harnessAcceptsModel(codex, "anthropic/claude-sonnet-4-5")).toBe(false);
});

test("harnessAcceptsModel: codex accepts its own family / an unset model / an unclassifiable string", () => {
	const codex = getHarness("codex")!;
	expect(harnessAcceptsModel(codex, "gpt-5.6-sol[high]")).toBe(true); // same lineage (openai)
	expect(harnessAcceptsModel(codex, undefined)).toBe(true); // nothing to check
	expect(harnessAcceptsModel(codex, "some-unclassifiable-string")).toBe(true); // never guessed
});

test("harnessAcceptsModel: grok (xai-pinned) refuses opus, accepts its own family", () => {
	const grok = getHarness("grok")!;
	expect(harnessAcceptsModel(grok, "opus")).toBe(false);
	expect(harnessAcceptsModel(grok, "grok-4.5")).toBe(true);
});

test("harnessAcceptsModel: claude-code (anthropic-pinned) accepts opus/sonnet, refuses an openai family", () => {
	const claudeCode = getHarness("claude-code")!;
	expect(harnessAcceptsModel(claudeCode, "opus")).toBe(true);
	expect(harnessAcceptsModel(claudeCode, "sonnet")).toBe(true);
	expect(harnessAcceptsModel(claudeCode, "gpt-5.6-sol")).toBe(false);
});

test("harnessAcceptsModel: multi-vendor harnesses (omp/pi/opencode/auggie) fail OPEN for any model — no static vendor pin to enforce", () => {
	for (const name of ["omp", "pi", "opencode", "auggie"]) {
		const d = getHarness(name)!;
		expect(harnessAcceptsModel(d, "opus")).toBe(true);
		expect(harnessAcceptsModel(d, "gpt-5.6-sol")).toBe(true);
		expect(harnessAcceptsModel(d, "grok-4.5")).toBe(true);
	}
});

test("nearestCompatibleModel: falls back to the descriptor's own staticModels[0] when declared, else undefined", () => {
	expect(nearestCompatibleModel(getHarness("claude-code")!)).toBe("default");
	expect(nearestCompatibleModel(getHarness("grok")!)).toBe("grok-4.5");
	// codex/gemini declare no staticModels (live-probed catalogs, not a small stable set) — honestly
	// undefined, never a guessed id.
	expect(nearestCompatibleModel(getHarness("codex")!)).toBeUndefined();
	expect(nearestCompatibleModel(getHarness("gemini")!)).toBeUndefined();
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

test("create() rejects an EXPLICIT cross-family model on a vendor-pinned harness (ticket #347) — same loud-reject idiom as sandbox/approval/thinking", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-modelcompat-explicit-"));
	tmps.push(stateDir);
	const repo = await makeRepo();
	const mgr = mgrFor(stateDir);
	// codex is openai-pinned; "opus" is an anthropic-family literal an operator explicitly chose —
	// the router never ran, so this must be a loud config error, not a silent remap.
	await expect(mgr.create({ name: "c", repo, harness: "codex", model: "opus", approvalMode: "yolo", autoRoute: false })).rejects.toThrow(/incompatible with harness "codex"/);
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

test("hasSecondVerifiedProviderLane: TRUE today — grok is verified and vendor-pinned to xai", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	// grok passed a live ACP smoke (initialize + session/new) and pins to `xai`, which differs from
	// omp's `unknown` baseline ⇒ the degradation ladder has a real second subscription lane to act on.
	// This is the assertion that would catch someone silently un-verifying grok and quietly re-inerting
	// the ladder — the exact class of "system lies about its own state" this registry exists to prevent.
	expect(hasSecondVerifiedProviderLane("omp")).toBe(true);
});

test("hasSecondVerifiedProviderLane: false when grok is the only pinned lane and it is unverified", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	// Roll back to the pre-grok, pre-claude-code, pre-codex world: omp/pi/opencode are verified but
	// multi-model (unknown lineage), and gemini is registered-but-unsmoked ⇒ no differentiation for the
	// ladder. claude-code (2026-07-16, daily-onramp 02) and codex (2026-08-04, ticket #336) each passed
	// their own live smoke since, so both must be held unverified here too for the pre-pinned-lane world
	// to exist at all.
	withHarnessOverride("grok", { verified: false }, () => {
		withHarnessOverride("claude-code", { verified: false }, () => {
			withHarnessOverride("codex", { verified: false }, () => {
				expect(hasSecondVerifiedProviderLane("omp")).toBe(false);
			});
		});
	});
});

test("hasSecondVerifiedProviderLane: OMP_SQUAD_UNVERIFIED_HARNESS=1 does NOT fabricate a lane (verified-only contract)", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	process.env.OMP_SQUAD_UNVERIFIED_HARNESS = "1"; // surfaces unverified harnesses on create UIs...
	// ...but an unsmoked gemini registration is NOT a real second subscription lane: telling the
	// dispatcher otherwise would trade the fleet-safety freeze for a lane that half-works. grok,
	// claude-code, AND codex (all genuinely verified today) are held unverified here so the ONLY thing
	// that could flip this true is the env escape hatch.
	withHarnessOverride("grok", { verified: false }, () => {
		withHarnessOverride("claude-code", { verified: false }, () => {
			withHarnessOverride("codex", { verified: false }, () => {
				expect(hasSecondVerifiedProviderLane("omp")).toBe(false);
			});
		});
	});
});

test("hasSecondVerifiedProviderLane: true once a vendor-pinned harness is actually verified and differs from the default", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	// claude-code HAS passed a live smoke (2026-07-16, daily-onramp 02) — the "simulate" of this
	// test's first life is now the registry's real state; the override just makes the flip explicit.
	withHarnessOverride("grok", { verified: false }, () => {
		withHarnessOverride("codex", { verified: false }, () => {
			withHarnessOverride("claude-code", { verified: true }, () => {
				expect(hasSecondVerifiedProviderLane("omp")).toBe(true); // anthropic-pinned lane, distinct from omp's unknown
			});
			withHarnessOverride("claude-code", { verified: false }, () => {
				expect(hasSecondVerifiedProviderLane("omp")).toBe(false); // all three pinned lanes held down — pre-grok world
			});
		});
	});
});

test("hasSecondVerifiedProviderLane: a vendor-pinned DEFAULT harness needs a genuinely different vendor to count", () => {
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	withHarnessOverride("grok", { verified: false }, () => {
		withHarnessOverride("codex", { verified: false }, () => {
			withHarnessOverride("claude-code", { verified: true }, () => {
				// default = claude-code (anthropic); the only other verified vendor-pinned harness is itself ⇒ false.
				expect(hasSecondVerifiedProviderLane("claude-code")).toBe(false);
				// A verified GOOGLE lane appears ⇒ genuinely different vendor ⇒ true.
				withHarnessOverride("gemini", { verified: true }, () => {
					expect(hasSecondVerifiedProviderLane("claude-code")).toBe(true);
				});
			});
		});
	});
});

test("grok: registered as a verified first-party ACP harness pinned to xai", () => {
	const d = getHarness("grok");
	expect(d).toBeDefined();
	expect(d?.protocol).toBe("acp");
	expect(d?.bin).toBe("grok");
	expect(d?.acpCommand).toEqual(["grok", "agent", "stdio"]); // no npx adapter — native ACP
	expect(d?.verified).toBe(true); // live smoke: initialize + session/new (see registry doc)
	expect(harnessLineage("grok")).toBe("xai");
	// Capabilities stay conservative: grok ADVERTISES loadSession:true, but SquadManager does not drive
	// session/load, so claiming resumable would hand the reattach path an agent it cannot restore.
	expect(d?.capabilities.resumable).toBe(false);
	expect(d?.capabilities.hostTools).toBe(false);
	// A verified harness must be offered without the unverified escape hatch.
	stashEnv("OMP_SQUAD_UNVERIFIED_HARNESS");
	delete process.env.OMP_SQUAD_UNVERIFIED_HARNESS;
	expect(listHarnesses().map((h) => h.name)).toContain("grok");
});

test("resolveAcpCommand: grok's --model precedes the `stdio` subcommand, or the CLI rejects it", () => {
	// LIVE: `grok agent stdio --model grok-4.5` ⇒ exit with "unexpected argument '--model'".
	//       `grok agent --model grok-4.5 stdio` ⇒ a real ACP initialize response.
	// This is the regression guard for that: a modeled grok unit must never be spawned with a trailing
	// --model. The bug was invisible to the initialize smoke, which passes no model at all.
	const grok = getHarness("grok")!;
	expect(resolveAcpCommand(grok, "grok-4.5")).toEqual(["grok", "agent", "--model", "grok-4.5", "stdio"]);
	expect(resolveAcpCommand(grok, "grok-4.5")).not.toEqual(["grok", "agent", "stdio", "--model", "grok-4.5"]);
	// No model pinned ⇒ the plain launch command, untouched.
	expect(resolveAcpCommand(grok, undefined)).toEqual(["grok", "agent", "stdio"]);
});

test("resolveAcpCommand: the DEFAULT trailing-append still holds for flag-style ACP harnesses", () => {
	const opencode = getHarness("opencode")!;
	expect(resolveAcpCommand(opencode, "some-model")).toEqual(["opencode", "acp", "--model", "some-model"]);
	expect(resolveAcpCommand(opencode, undefined)).toEqual(["opencode", "acp"]);
	// omp-rpc harnesses carry no acpCommand ⇒ undefined, never a fabricated argv.
	expect(resolveAcpCommand(getHarness("omp")!, "opus")).toBeUndefined();
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

test("harnessTierInfo/binResolvable: a thin daemon PATH still finds a harness binary sitting in a well-known install dir (post-ship harness-dropdown fix)", async () => {
	// Reproduces the bare-nohup-respawn failure mode directly: HOME points at a fixture user whose
	// ~/.local/bin holds the harness binary, but PATH is deliberately thin (no ~/.local/bin entry at
	// all) — the exact shape of a daemon respawned via `nohup omp-squad up &` from a non-interactive
	// shell that never sourced the user's profile.
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "harness-wellknown-home-"));
	tmps.push(home);
	const localBin = path.join(home, ".local", "bin");
	await fs.mkdir(localBin, { recursive: true });
	const fake = path.join(localBin, "definitely-not-on-a-thin-path-xyz");
	await fs.writeFile(fake, "#!/bin/sh\necho hi\n");
	await fs.chmod(fake, 0o755);

	stashEnv("HOME", "PATH");
	process.env.HOME = home;
	process.env.PATH = "/usr/bin:/bin"; // deliberately thin — no ~/.local/bin entry

	withHarnessOverride("gemini", { verified: true, bin: "definitely-not-on-a-thin-path-xyz", acpCommand: ["definitely-not-on-a-thin-path-xyz", "--acp"] }, () => {
		_resetHarnessTierCacheForTests();
		const info = harnessTierInfo(getHarness("gemini")!);
		expect(info.binDetected).toBe(true);
		expect(info.alert).toBeUndefined();
	});
	_resetHarnessTierCacheForTests();
});

test("harnessTierInfo/binResolvable: a binary that is genuinely absent (even from every well-known dir) still reports not-detected — the fallback does not manufacture false positives", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "harness-wellknown-absent-home-"));
	tmps.push(home);
	stashEnv("HOME", "PATH");
	process.env.HOME = home;
	process.env.PATH = "/usr/bin:/bin";

	withHarnessOverride("gemini", { verified: true, bin: "truly-nowhere-on-this-machine-xyz", acpCommand: ["truly-nowhere-on-this-machine-xyz", "--acp"] }, () => {
		_resetHarnessTierCacheForTests();
		const info = harnessTierInfo(getHarness("gemini")!);
		expect(info.binDetected).toBe(false);
		expect(info.alert).toMatch(/not found on the daemon PATH/);
	});
	_resetHarnessTierCacheForTests();
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
	expect(visible).toEqual(expect.arrayContaining(["omp", "pi", "opencode", "grok"]));
	expect(visible).not.toContain("gemini");
	// grok (vendor-pinned xai, verified) is exactly the second provider lane this gate waits for —
	// registering it flips the ladder live. The tier machinery still must not perturb the inputs.
	expect(hasSecondVerifiedProviderLane("omp")).toBe(true);
});

test("globalDefaultHarness honors GLANCE_HARNESS, else omp", () => {
	stashEnv("GLANCE_HARNESS");
	delete process.env.GLANCE_HARNESS;
	expect(globalDefaultHarness()).toBe("omp");
	process.env.GLANCE_HARNESS = "claude-code";
	expect(globalDefaultHarness()).toBe("claude-code");
});
