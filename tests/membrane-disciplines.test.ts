/**
 * plans/eap-borrows concern 05 (membrane disciplines): the two glance-native prompt blocks
 * (verdict-first / minimal-code), their unconditional v1 placement on judge/lens/planner SYSTEM
 * prompts, the implementer-unit opt-in channel (gateMembraneTokens + membraneDisciplinePrompt, double
 * gate #2 = OMP_SQUAD_MEMBRANE_PROFILES, toolGrants isolation preserved), and the auto-disable breaker
 * (runtime-settings.ts#checkMembraneBreaker / runMembraneBreaker).
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	gateMembraneTokens,
	membraneDisciplinePrompt,
	membraneProfilesEnabled,
	MINIMAL_CODE_BLOCK,
	VERDICT_FIRST_BLOCK,
} from "../src/agent-profiles.ts";
import { LENS_SYSTEM_PROMPTS, LENS_VERIFY_SYSTEM, SYSTEM_PROMPT } from "../src/validator.ts";
import { buildDecomposePrompt } from "../src/planner.ts";
import {
	checkMembraneBreaker,
	MEMBRANE_BREAKER_MIN_EDGE,
	MEMBRANE_BREAKER_MIN_UNITS,
	runMembraneBreaker,
	RuntimeSettingsStore,
} from "../src/runtime-settings.ts";
import type { CellMetrics } from "../src/omp-graph/task-class-matrix.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
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

// ── Block wording / carve-outs ──────────────────────────────────────────────────────────────────────

test("VERDICT_FIRST_BLOCK names its byte-exact carve-outs", () => {
	expect(VERDICT_FIRST_BLOCK).toMatch(/safety refusal/i);
	expect(VERDICT_FIRST_BLOCK).toMatch(/destructive-action warning/i);
	expect(VERDICT_FIRST_BLOCK).toMatch(/error text/i);
});

test("MINIMAL_CODE_BLOCK has 7 rungs and names its hard carve-outs", () => {
	for (const rung of ["(1)", "(2)", "(3)", "(4)", "(5)", "(6)", "(7)"]) expect(MINIMAL_CODE_BLOCK).toContain(rung);
	expect(MINIMAL_CODE_BLOCK).toMatch(/input validation/i);
	expect(MINIMAL_CODE_BLOCK).toMatch(/data-loss/i);
	expect(MINIMAL_CODE_BLOCK).toMatch(/security/i);
	expect(MINIMAL_CODE_BLOCK).toMatch(/one runnable check/i);
});

// ── v1 placement: judges + planner get verdict-first unconditionally, JSON schema stays byte-exact ──

test("validator SYSTEM_PROMPT carries VERDICT_FIRST_BLOCK and its JSON verdict schema is byte-exact", () => {
	expect(SYSTEM_PROMPT).toContain(VERDICT_FIRST_BLOCK);
	expect(SYSTEM_PROMPT).toContain('{"perCriterion":[{"id":"<criterion id>","satisfied":true|false,"note":"<short reason>"}],"confidence":0..1,"rationale":"<short overall rationale>"}');
});

test("lens SYSTEM prompts carry VERDICT_FIRST_BLOCK and their JSON schema is byte-exact", () => {
	expect(LENS_SYSTEM_PROMPTS.regression).toContain(VERDICT_FIRST_BLOCK);
	expect(LENS_SYSTEM_PROMPTS.regression).toContain('{"disposition":"accept"|"object","severity":"low"|"high","claim":"<one-line reason; empty string if accept>"}');
});

test("LENS_VERIFY_SYSTEM carries VERDICT_FIRST_BLOCK and its JSON schema is byte-exact", () => {
	expect(LENS_VERIFY_SYSTEM).toContain(VERDICT_FIRST_BLOCK);
	expect(LENS_VERIFY_SYSTEM).toContain('{"verdict":"confirmed"|"refuted"|"inconclusive"}');
});

test("planner buildDecomposePrompt carries VERDICT_FIRST_BLOCK and still demands a JSON array", () => {
	const prompt = buildDecomposePrompt("obj", [], []);
	expect(prompt).toContain(VERDICT_FIRST_BLOCK);
	expect(prompt.toLowerCase()).toContain("json array");
});

// ── Implementer-unit opt-in: double gate #2 + unknown-token warning (agent-profiles.ts, pure) ────────

test("membraneProfilesEnabled defaults OFF", () => {
	stashEnv("OMP_SQUAD_MEMBRANE_PROFILES");
	delete process.env.OMP_SQUAD_MEMBRANE_PROFILES;
	expect(membraneProfilesEnabled()).toBe(false);
});

test("gateMembraneTokens: gate #2 off drops every requested token, even a recognized one", () => {
	stashEnv("OMP_SQUAD_MEMBRANE_PROFILES");
	delete process.env.OMP_SQUAD_MEMBRANE_PROFILES;
	expect(gateMembraneTokens(["membrane:verdict-first"])).toBeUndefined();
});

test("gateMembraneTokens: gate #2 on keeps recognized tokens, drops+warns on an unrecognized one", () => {
	stashEnv("OMP_SQUAD_MEMBRANE_PROFILES");
	process.env.OMP_SQUAD_MEMBRANE_PROFILES = "1";
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (msg: string) => warnings.push(msg);
	try {
		const gated = gateMembraneTokens(["membrane:verdict-first", "membrane:typo"], "some-profile");
		expect(gated).toEqual(["membrane:verdict-first"]);
		expect(warnings.some((w) => w.includes("membrane:typo") && w.includes("some-profile"))).toBe(true);
	} finally {
		console.warn = origWarn;
	}
});

test("gateMembraneTokens: undefined/empty input is a no-op, no warning", () => {
	stashEnv("OMP_SQUAD_MEMBRANE_PROFILES");
	process.env.OMP_SQUAD_MEMBRANE_PROFILES = "1";
	expect(gateMembraneTokens(undefined)).toBeUndefined();
	expect(gateMembraneTokens([])).toBeUndefined();
});

test("membraneDisciplinePrompt renders both blocks, deduped, undefined for empty", () => {
	expect(membraneDisciplinePrompt(undefined)).toBeUndefined();
	expect(membraneDisciplinePrompt([])).toBeUndefined();
	expect(membraneDisciplinePrompt(["membrane:verdict-first"])).toBe(VERDICT_FIRST_BLOCK);
	const both = membraneDisciplinePrompt(["membrane:verdict-first", "membrane:minimal-code", "membrane:verdict-first"]);
	expect(both).toContain(VERDICT_FIRST_BLOCK);
	expect(both).toContain(MINIMAL_CODE_BLOCK);
	// deduped: verdict-first's text appears exactly once even though it was requested twice
	expect(both?.split(VERDICT_FIRST_BLOCK).length).toBe(2);
});

// ── End-to-end delivery: SquadManager wiring, toolGrants isolation, ACP no-stamp ──────────────────────

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
	toolGrants?: string[];
	efficiencyFlags?: string[];
	options: { appendSystemPrompt?: string };
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

test("gate #2 ON + native harness: the membrane block reaches the composed system prompt AND toolGrants stays isolated", async () => {
	stashEnv("OMP_SQUAD_PROFILES", "OMP_SQUAD_MEMBRANE_PROFILES");
	process.env.OMP_SQUAD_MEMBRANE_PROFILES = "1";
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "native-membrane", name: "Native membrane", capabilities: ["read", "membrane:verdict-first"] }]);
	const { mgr, repo } = await makeMgr("membrane-native");
	const dto = await mgr.create({ name: "u", repo, profileId: "native-membrane", approvalMode: "yolo", autoRoute: false });
	expect(dto.harnessCaps?.contextInjection).toBe("native");
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.efficiencyFlags).toEqual(["membrane:verdict-first"]);
	expect(rec.toolGrants).toEqual(["read"]); // membrane token never leaked into the tool allow-list
	expect(rec.options.appendSystemPrompt).toContain(VERDICT_FIRST_BLOCK);
	await mgr.stop();
});

test("gate #2 OFF (default): a native-harness unit's system prompt carries NEITHER the block NOR the confirmed flag", async () => {
	stashEnv("OMP_SQUAD_PROFILES", "OMP_SQUAD_MEMBRANE_PROFILES");
	delete process.env.OMP_SQUAD_MEMBRANE_PROFILES;
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "native-membrane-off", name: "Native membrane off", capabilities: ["read", "membrane:verdict-first"] }]);
	const { mgr, repo } = await makeMgr("membrane-gate-off");
	const dto = await mgr.create({ name: "u", repo, profileId: "native-membrane-off", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.efficiencyFlags).toBeUndefined(); // gate #2 off ⇒ never confirmed, no placebo stamp
	expect(rec.toolGrants).toEqual(["read"]);
	expect(rec.options.appendSystemPrompt ?? "").not.toContain(VERDICT_FIRST_BLOCK);
	await mgr.stop();
});

test("ACP-none harness: gate #2 on, contextInjection=none never stamps a confirmed flag (the block still rides options.appendSystemPrompt but never reaches the child)", async () => {
	stashEnv("OMP_SQUAD_PROFILES", "OMP_SQUAD_MEMBRANE_PROFILES");
	process.env.OMP_SQUAD_MEMBRANE_PROFILES = "1";
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "acp-membrane-05", name: "ACP membrane", harness: "opencode", capabilities: ["read", "membrane:verdict-first"] }]);
	const { mgr, repo } = await makeMgr("membrane-acp");
	const dto = await mgr.create({ name: "u", repo, profileId: "acp-membrane-05", approvalMode: "yolo", autoRoute: false });
	expect(dto.harnessCaps?.contextInjection).toBe("none");
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	// The invariant that matters: contextInjection=none never CONFIRMS the flag (concern 02 semantics —
	// stamping here would measure a placebo, since the appended prompt is silently dropped before the
	// child ever sees it — see receipts.ts#confirmDeliveredFlags and acp-agent-driver.ts).
	expect(rec.efficiencyFlags).toBeUndefined();
	expect(rec.toolGrants).toEqual(["read"]);
	// NOT proof the child never sees the block: gate #2 alone still composes it into
	// rec.options.appendSystemPrompt (the driver-level drop happens downstream, inside
	// acp-agent-driver.ts, which this FakeDriver-backed test never exercises).
	expect(rec.options.appendSystemPrompt).toContain(VERDICT_FIRST_BLOCK);
	await mgr.stop();
});

// ── Breaker: trips on a synthetic degraded cohort, and the setting reads disabled afterward ──────────

function cell(overrides: Partial<CellMetrics>): CellMetrics {
	return {
		n: MEMBRANE_BREAKER_MIN_UNITS,
		landed: MEMBRANE_BREAKER_MIN_UNITS,
		mergeRate: 1,
		nWithCost: 0,
		costCoveragePct: 1,
		nWithTokens: 0,
		tokensCoveragePct: 1,
		insufficientData: false,
		reproducible: true,
		...overrides,
	};
}

test("checkMembraneBreaker: healthy cohort (matches baseline) does not trip", () => {
	const baseline = cell({ mergeRate: 0.9 });
	const flagged = cell({ mergeRate: 0.9 });
	expect(checkMembraneBreaker(flagged, baseline).tripped).toBe(false);
});

test("checkMembraneBreaker: a mergeRate drop past MIN_EDGE trips", () => {
	const baseline = cell({ mergeRate: 0.9 });
	const flagged = cell({ mergeRate: 0.9 - MEMBRANE_BREAKER_MIN_EDGE - 0.01 });
	const result = checkMembraneBreaker(flagged, baseline);
	expect(result.tripped).toBe(true);
	expect(result.reason).toMatch(/mergeRate dropped/);
});

test("checkMembraneBreaker: below MEMBRANE_BREAKER_MIN_UNITS never trips even with a big drop", () => {
	const baseline = cell({ mergeRate: 0.9 });
	const flagged = cell({ mergeRate: 0.1, n: MEMBRANE_BREAKER_MIN_UNITS - 1 });
	expect(checkMembraneBreaker(flagged, baseline).tripped).toBe(false);
});

test("checkMembraneBreaker: a non-reproducible cell never trips (comparing against noise)", () => {
	const baseline = cell({ mergeRate: 0.9, reproducible: false });
	const flagged = cell({ mergeRate: 0.1 });
	expect(checkMembraneBreaker(flagged, baseline).tripped).toBe(false);
});

test("checkMembraneBreaker: a higher vetoRate trips even with an unchanged mergeRate", () => {
	const baseline = cell({ mergeRate: 0.9, vetoRate: 0.05 });
	const flagged = cell({ mergeRate: 0.9, vetoRate: 0.4 });
	const result = checkMembraneBreaker(flagged, baseline);
	expect(result.tripped).toBe(true);
	expect(result.reason).toMatch(/vetoRate rose/);
});

test("runMembraneBreaker: trips on a synthetic degraded cohort, hard-disables the setting, and files an AttentionEvent", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "membrane-breaker-"));
	tmps.push(dir);
	const store = new RuntimeSettingsStore(dir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);
	let states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(true);

	const baseline = cell({ mergeRate: 0.9 });
	const flagged = cell({ mergeRate: 0.9 - MEMBRANE_BREAKER_MIN_EDGE - 0.05 });
	const event = await runMembraneBreaker(store, "tdd:heavy", flagged, baseline);

	expect(event).toBeDefined();
	expect(event?.summary).toContain("tdd:heavy");
	expect(event?.source).toBe("notify");

	states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(false);
	expect(process.env.OMP_SQUAD_MEMBRANE_PROFILES).toBe("0");
});

test("runMembraneBreaker: a healthy cohort leaves the setting untouched and returns undefined", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "membrane-breaker-healthy-"));
	tmps.push(dir);
	const store = new RuntimeSettingsStore(dir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	const baseline = cell({ mergeRate: 0.9 });
	const flagged = cell({ mergeRate: 0.9 });
	const event = await runMembraneBreaker(store, "tdd:heavy", flagged, baseline);

	expect(event).toBeUndefined();
	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(true);
});
