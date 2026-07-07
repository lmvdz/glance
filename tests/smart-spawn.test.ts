/**
 * Smart-spawn resolver — deterministic pieces (repo discovery, naming, repo
 * heuristic, JSON extraction). The live model path (planSpawn → omp --smol) is
 * exercised end to end via the daemon, not here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assemblePlan, COST_TIE_EPSILON, discoverRepos, eligibleCandidates, MIN_EDGE, MIN_SAMPLES, parsePlanJson, pickRepoHeuristic, slug } from "../src/smart-spawn.ts";
import { buildScoreboard, type Scoreboard } from "../src/attribution-scoreboard.ts";
import { DEFAULT_MODEL_FAMILY, type ModelOutcomes } from "../src/model-outcomes.ts";
import type { RunReceipt } from "../src/types.ts";

afterEach(() => {
	delete process.env.OMP_SQUAD_REPO_ROOTS;
	delete process.env.OMP_SQUAD_MODEL_OUTCOMES;
});

async function gitDir(parent: string, name: string): Promise<string> {
	const d = path.join(parent, name);
	await fs.mkdir(path.join(d, ".git"), { recursive: true });
	return d;
}

test("slug makes a short kebab name and never empty", () => {
	expect(slug("Add rate limiting to the login route")).toBe("add-rate-limiting-to");
	expect(slug("Fix bug #42 in Parser")).toBe("fix-bug-42-in");
	expect(slug("   !!!   ")).toBe("agent");
});

test("discoverRepos returns cwd + scanned roots (git repos only, absolute)", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "disc-"));
	const repoA = await gitDir(root, "alpha");
	const repoB = await gitDir(root, "beta");
	await fs.mkdir(path.join(root, "not-a-repo"), { recursive: true });
	const cwd = await gitDir(root, "cwdrepo");
	process.env.OMP_SQUAD_REPO_ROOTS = root;

	const repos = discoverRepos(cwd, []);
	expect(repos).toContain(path.resolve(repoA));
	expect(repos).toContain(path.resolve(repoB));
	expect(repos).toContain(path.resolve(cwd));
	expect(repos).not.toContain(path.resolve(path.join(root, "not-a-repo")));
	for (const r of repos) expect(path.isAbsolute(r)).toBe(true);
});

test("pickRepoHeuristic prefers a candidate the task names, else cwd, else first", () => {
	const cands = ["/x/omp-squad", "/x/web-app", "/x/api"];
	expect(pickRepoHeuristic("fix the web-app login", cands, "/x/api")).toBe("/x/web-app");
	expect(pickRepoHeuristic("do something generic", cands, "/x/api")).toBe("/x/api");
	expect(pickRepoHeuristic("do something generic", cands, "/elsewhere")).toBe("/x/omp-squad");
});

test("parsePlanJson extracts one object from noisy output and coerces/ trims fields", () => {
	const raw = parsePlanJson('sure!\n{"repo": " /x/app ", "name": "do-thing", "approval":"yolo", "junk": 5}\nthanks');
	expect(raw?.repo).toBe("/x/app");
	expect(raw?.name).toBe("do-thing");
	expect(raw?.approval).toBe("yolo");
	expect(raw?.model).toBeUndefined();
	expect(parsePlanJson("no json here")).toBeUndefined();
	expect(parsePlanJson('{"a":}')).toBeUndefined();
});

// ── Outcome-driven, cost-weighted model default (Epic 6 concern 07; research-sirvir/04) ────────

describe("assemblePlan — outcome-driven model default shift", () => {
	const candidates = ["/x/omp-squad"];
	const cwd = "/x/omp-squad";

	const rc = (model: string, costUsd: number): RunReceipt => ({
		agentId: `a-${model}-${costUsd}`,
		name: "r",
		repo: "/repo",
		model,
		runId: "r",
		startedAt: 0,
		endedAt: 1,
		durationMs: 1,
		status: "stopped",
		toolCalls: 0,
		toolTally: {},
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		costUsd,
		filesTouched: [],
	});

	/** Build a real `Scoreboard` the same way production code does (`buildScoreboard`) — a `ModelOutcomes`
	 *  ledger for land-rate, plus optional receipts to price a model's `costPerLandedChange`. Reusing the
	 *  already-tested pure function keeps these fixtures honest instead of hand-rolling a parallel shape. */
	function scoreboardFrom(outcomes: ModelOutcomes, receipts: RunReceipt[] = []): Scoreboard {
		return buildScoreboard(receipts, outcomes);
	}

	test("flag off (default): no shift even with a strongly-winning candidate", () => {
		const scoreboard = scoreboardFrom({ "opus::heavy": { landed: 8, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 1, rejected: 9 } });
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test("flag on + >= MIN_SAMPLES + edge cleared: shifts to the better-landing model and appends a reason", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const scoreboard = scoreboardFrom({ "opus::heavy": { landed: 7, rejected: 1 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 1, rejected: 7 } }); // opus 0.875, default 0.125 → edge 0.75 >> 0.15
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBe("opus");
		expect(plan.reason).toContain("model shifted to opus");
		expect(plan.reason).toContain("heavy");
	});

	test(`flag on but a candidate has fewer than MIN_SAMPLES (${MIN_SAMPLES}) total outcomes: no shift (cold, not eligible to win)`, () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const scoreboard = scoreboardFrom({ "opus::heavy": { landed: 3, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 1, rejected: 9 } }); // opus has only 3 samples < 8
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test(`flag on but the edge is below MIN_EDGE (${MIN_EDGE}) and cost data is absent: no shift, default stands`, () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const scoreboard = scoreboardFrom({ "opus::heavy": { landed: 5, rejected: 3 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 5, rejected: 4 } }); // opus 0.625 vs default 0.556 → edge ~0.07 < 0.15, no receipts ⇒ no cost data
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test("an explicit LLM-supplied model is NEVER overridden, even with a winning candidate available", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const scoreboard = scoreboardFrom({ "opus::heavy": { landed: 8, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 0, rejected: 8 } });
		const plan = assemblePlan("do it", candidates, cwd, { model: "sonnet", thinking: "high" }, { scoreboard });
		expect(plan.model).toBe("sonnet");
	});

	test("no scoreboard injected: no shift even with the flag on", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" });
		expect(plan.model).toBeUndefined();
	});

	test("a cold candidate is never starved below the baseline — an undecided shift just leaves the default untouched", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// Neither candidate has enough samples: the shift must be a pure no-op, never an implicit demotion.
		const scoreboard = scoreboardFrom({ "opus::mid": { landed: 1, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::mid`]: { landed: 0, rejected: 0 } });
		const plan = assemblePlan("do it", candidates, cwd, {}, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test("(S1 regression) a fat winner vs a COLD/unseen incumbent yields NO shift — the incumbent floor is symmetric with the winner's", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// opus clears MIN_SAMPLES (8) at a mediocre 0.25 land rate; "default" was NEVER measured ({0,0}).
		// Trusting the incumbent's unmeasured 0% rate would flip EVERY mid-tier omitted-model spawn to
		// opus (0.25 - 0 = 0.25 >= MIN_EDGE) despite opus's own poor record — starving the cold incumbent.
		const scoreboard = scoreboardFrom({ "opus::mid": { landed: 2, rejected: 6 } }); // default has no row at all
		const plan = assemblePlan("do it", candidates, cwd, {}, { scoreboard });
		expect(plan.model).toBeUndefined(); // cold incumbent ⇒ no basis for comparison ⇒ base heuristic stands
	});

	test("(S1 regression) a thinly-measured incumbent (below MIN_SAMPLES) also blocks the shift", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// opus: 8 samples @ 0.875; default: only 3 samples (below the floor) — even a strong winner must wait.
		const scoreboard = scoreboardFrom({ "opus::heavy": { landed: 7, rejected: 1 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 3, rejected: 0 } });
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test("record/read bucketing agree: a 'medium'/undefined thinking task reads the 'mid' tier", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const scoreboard = scoreboardFrom({ "opus::mid": { landed: 8, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::mid`]: { landed: 0, rejected: 8 } });
		const plan = assemblePlan("do it", candidates, cwd, {}, { scoreboard }); // no thinking ⇒ tierOf(undefined) === "mid"
		expect(plan.model).toBe("opus");
	});

	// ── Cost tie-break (research-sirvir/04) ───────────────────────────────────────────────────────

	test("(a) equal land-rate, different cost: the cheaper model wins at equal quality", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes: ModelOutcomes = { "opus::mid": { landed: 4, rejected: 4 }, [`${DEFAULT_MODEL_FAMILY}::mid`]: { landed: 4, rejected: 4 } }; // identical 0.5 land-rate
		const receipts = [rc("opus", 1.0), rc(DEFAULT_MODEL_FAMILY, 3.0), rc(DEFAULT_MODEL_FAMILY, 3.0), rc(DEFAULT_MODEL_FAMILY, 3.0), rc(DEFAULT_MODEL_FAMILY, 3.0)]; // opus $1/landed*4=0.25/landed; default $3
		const scoreboard = scoreboardFrom(outcomes, receipts);
		const plan = assemblePlan("do it", candidates, cwd, {}, { scoreboard });
		expect(plan.model).toBe("opus");
		expect(plan.reason).toContain("cheaper at equal quality");
	});

	test("(a-inverse) equal land-rate, candidate is PRICIER than incumbent: no shift — cost never promotes a costlier equal", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes: ModelOutcomes = { "opus::mid": { landed: 4, rejected: 4 }, [`${DEFAULT_MODEL_FAMILY}::mid`]: { landed: 4, rejected: 4 } };
		const receipts = [rc("opus", 3.0), rc("opus", 3.0), rc("opus", 3.0), rc("opus", 3.0), rc(DEFAULT_MODEL_FAMILY, 1.0)]; // opus pricier per landed change
		const scoreboard = scoreboardFrom(outcomes, receipts);
		const plan = assemblePlan("do it", candidates, cwd, {}, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test("(b) higher land-rate but pricier: the better lander still wins — escalation is NOT vetoed by cost", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes: ModelOutcomes = { "opus::heavy": { landed: 8, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 1, rejected: 7 } }; // opus 1.0 vs default 0.125 — a real quality win
		const receipts = [rc("opus", 40), rc("opus", 40), rc("opus", 40), rc("opus", 40), rc("opus", 40), rc("opus", 40), rc("opus", 40), rc("opus", 40), rc(DEFAULT_MODEL_FAMILY, 0.5)]; // opus MUCH pricier per landed change (a >100x ratio — exactly what the old unbounded penalty would have vetoed)
		const scoreboard = scoreboardFrom(outcomes, receipts);
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBe("opus");
		expect(plan.reason).not.toContain("cheaper at equal quality"); // quality win, not a cost tie-break
	});

	test("(c) null incumbent cost never crashes the comparison (no -Infinity, no NaN) and a real quality win still fires", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// default has land-rate samples but ZERO daemon receipts ⇒ costPerLandedChange stays null.
		const outcomes: ModelOutcomes = { "opus::heavy": { landed: 8, rejected: 0 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 1, rejected: 7 } };
		const receipts = [rc("opus", 5)]; // opus has cost data; default does not
		const scoreboard = scoreboardFrom(outcomes, receipts);
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBe("opus"); // MIN_EDGE alone already clears it — cost (null or not) is irrelevant here
		expect(plan.reason).toContain("model shifted to opus");
	});

	test(`(c) null cost data at a near-tied land-rate (within COST_TIE_EPSILON=${COST_TIE_EPSILON}): no shift, never a crash`, () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// Land-rates are within epsilon of each other but NEITHER side has receipts ⇒ costPerLandedChange
		// is null on both ⇒ the cost tie-break must skip cleanly rather than divide by a null cost.
		const outcomes: ModelOutcomes = { "opus::mid": { landed: 4, rejected: 4 }, [`${DEFAULT_MODEL_FAMILY}::mid`]: { landed: 4, rejected: 4 } };
		const scoreboard = scoreboardFrom(outcomes); // no receipts at all
		const plan = assemblePlan("do it", candidates, cwd, {}, { scoreboard });
		expect(plan.model).toBeUndefined();
	});

	test("(d) all existing shiftedModel invariants above still hold with cost data present but out of MIN_EDGE range", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// Edge is comfortably below MIN_EDGE (0.625 vs 0.556, ~0.07 edge) AND also outside COST_TIE_EPSILON
		// (0.07 > 0.05) — cost must not rescue a candidate that clears neither gate.
		const outcomes: ModelOutcomes = { "opus::heavy": { landed: 5, rejected: 3 }, [`${DEFAULT_MODEL_FAMILY}::heavy`]: { landed: 5, rejected: 4 } };
		const receipts = [rc("opus", 0.01)]; // opus dirt cheap — must still not win, edge is too wide for a tie-break
		const scoreboard = scoreboardFrom(outcomes, receipts);
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { scoreboard });
		expect(plan.model).toBeUndefined();
	});
});

// ── Cross-provider leak guard (research-sirvir/02, red-team MINOR 5) ───────────────────────────

describe("eligibleCandidates", () => {
	test("excludes a family from a different vendor's subscription for the default (anthropic) provider", () => {
		expect(eligibleCandidates(["opus", "sonnet", "openai", "gemini"])).toEqual(["opus", "sonnet"]);
	});

	test("never let a well-landing openai family become the chosen model for an Anthropic-subscription omp unit", () => {
		// Same shape as the real SHIFT_CANDIDATES eligibility scan: an `openai` candidate would win
		// outright on outcomes alone (it's the only one clearing MIN_SAMPLES with a good rate), but it
		// must never even enter the comparison for the default anthropic provider.
		expect(eligibleCandidates(["opus", "openai"])).toEqual(["opus"]);
	});

	test("parameterized by provider — an openai-scoped caller keeps openai and drops anthropic families", () => {
		expect(eligibleCandidates(["opus", "sonnet", "openai"], "openai")).toEqual(["openai"]);
	});

	test("an empty candidate list stays empty", () => {
		expect(eligibleCandidates([])).toEqual([]);
	});
});
