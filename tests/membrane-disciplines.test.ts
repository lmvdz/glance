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
import type { AgentDTO, AttentionEvent, PersistedAgent, RpcSessionState } from "../src/types.ts";
import type { AutomationLog } from "../src/automation-log.ts";

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

test("checkMembraneBreaker: a sample-insufficient baseline never trips (comparing against noise)", () => {
	// Round-2 review fix: the gate no longer reads either cell's own self-doc `.reproducible` bit (that
	// bit is meaningless for the flagged cohort's single-cell doc — see the mergeRate-0 test below). It
	// gates on `isSampleSufficient` directly: a baseline whose `n` never cleared the floor is noise.
	//
	// Code-review finding #7 update: `isSampleSufficient` no longer folds in a cost-coverage floor —
	// mergeRate/vetoRate/inRunReworkRate never read cost, so gating them on `costCoveragePct` starved
	// this exact breaker on a fleet whose rows mostly lack `costUsd`. A thin-COST (but sample-sufficient
	// `n`) baseline now legitimately trips; the "still noise" case this test guards is thin `n`, not
	// thin cost coverage — see the next test for the corrected thin-cost-coverage behavior.
	const baseline = cell({ mergeRate: 0.9, n: 1 }); // below the matrix's MIN_SAMPLES=3 floor
	const flagged = cell({ mergeRate: 0.1 });
	expect(checkMembraneBreaker(flagged, baseline).tripped).toBe(false);
});

test("checkMembraneBreaker: a baseline with thin COST coverage but sufficient n still trips (finding #7)", () => {
	// The corrected behavior for the scenario the OLD test above mislabeled "noise": mergeRate/
	// vetoRate/inRunReworkRate are computed off every outcome row, not just cost-bearing ones — thin
	// cost coverage alone says nothing about whether there's enough mergeRate evidence to compare on.
	const baseline = cell({ mergeRate: 0.9, costCoveragePct: 0.1 });
	const flagged = cell({ mergeRate: 0.1, costCoveragePct: 0.1 });
	const result = checkMembraneBreaker(flagged, baseline);
	expect(result.tripped).toBe(true);
	expect(result.reason).toMatch(/mergeRate dropped/);
});

test("checkMembraneBreaker: a saturated mergeRate-0 flagged cohort trips against a healthy baseline (structural-inertness fix)", () => {
	// This is the exact case that was structurally inert before the round-2 fix: `membraneBreakerCadence`
	// collapses the flagged cohort into a single-cell matrix doc where that cell is its own "champion",
	// so `flagged.reproducible` (self-compared) was ALWAYS false whenever the cohort's own mergeRate
	// saturated at 0 or 1 — a catastrophic mergeRate-0 cohort could never trip the breaker. Gating on
	// `hasVarianceBetween(flagged, baseline)` (the CROSS-cell comparison) instead fixes it: 0 vs 0.9 is
	// real variance regardless of either cell's own self-doc reproducible bit.
	const baseline = cell({ mergeRate: 0.9 });
	const flagged = cell({ mergeRate: 0, landed: 0 });
	const result = checkMembraneBreaker(flagged, baseline);
	expect(result.tripped).toBe(true);
	expect(result.reason).toMatch(/mergeRate dropped/);
});

test("checkMembraneBreaker: a saturated mergeRate-1.0 tie does not block the vetoRate arm (structural-inertness fix)", () => {
	// The other half of the same bug: the live fleet's documented saturated regime is `mergeRate` pinned
	// at 1.0 (all collapsed outcomes are `landed`) — the OLD gate required BOTH cells' self-doc
	// `.reproducible`, which is false for a cell self-compared against its own champion at a saturated
	// mergeRate, silently defeating the vetoRate/inRunReworkRate arms. `hasVarianceBetween` now gates
	// ONLY the mergeRate arm (mirroring `flagEfficiencyRegression`'s precedent) — a degraded vetoRate must
	// still trip even though both cells sit at the saturated mergeRate-1.0 tie point.
	const baseline = cell({ mergeRate: 1, vetoRate: 0.05 });
	const flagged = cell({ mergeRate: 1, vetoRate: 0.4 });
	const result = checkMembraneBreaker(flagged, baseline);
	expect(result.tripped).toBe(true);
	expect(result.reason).toMatch(/vetoRate rose/);
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

// ── Round-2 review fix: a breaker trip is human-visible via the attention lane, not a log line ────────

test("SquadManager#fileMembraneBreakerFinding: a breaker trip attaches to the triggering unit's attention lane AND the land automation channel", async () => {
	// Round-2 review fix: the trip escalation used to be `this.log("warn", ...)` — a log line nobody in
	// the cockpit is watching for a hard fleet-wide auto-disable. It must land on BOTH the "Needs you"
	// attention lane (AgentDTO.attentionEvents — the SAME channel squad_attention/glance notify use) AND
	// the "land" automation channel (fileLandBlockedFinding's precedent; concern 04's #12 fix uses the
	// equivalent "observer" channel for a gate-unrunnable finding) so it survives even if the triggering
	// unit is reaped before a human looks.
	const { mgr, repo } = await makeMgr("membrane-breaker-finding");
	const dto = await mgr.create({ name: "u", repo, approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)! as unknown as { dto: AgentDTO };
	expect(rec.dto.attentionEvents ?? []).toEqual([]);

	const event: AttentionEvent = {
		id: "membrane-breaker:tdd:heavy:1",
		summary: 'Membrane profile disciplines auto-disabled — measured success degradation on taskClass "tdd:heavy"',
		detail: "mergeRate dropped 20.0pt vs baseline (n=5)",
		source: "notify",
		createdAt: Date.now(),
	};
	(mgr as unknown as { fileMembraneBreakerFinding: (rec: unknown, repo: string, event: AttentionEvent) => void }).fileMembraneBreakerFinding(
		(mgr as unknown as InternalHost).agents.get(dto.id)!,
		repo,
		event,
	);

	// 1. Attention lane: the event is attached to the triggering unit's DTO, human-visible in the cockpit's
	//    "Needs you" surface exactly like a squad_attention call.
	expect(rec.dto.attentionEvents).toHaveLength(1);
	expect(rec.dto.attentionEvents?.[0]).toEqual(event);

	// 2. Automation channel: also surfaces in /api/automation + the automation panel, independent of
	//    whether the triggering unit is still live by the time a human looks.
	const recent = (mgr as unknown as { automation: AutomationLog }).automation.recent({ loop: "land" });
	expect(recent.some((e) => e.detail?.includes("Membrane profile disciplines auto-disabled") && e.level === "warn")).toBe(true);

	await mgr.stop();
});
