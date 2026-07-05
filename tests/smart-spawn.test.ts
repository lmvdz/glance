/**
 * Smart-spawn resolver — deterministic pieces (repo discovery, naming, repo
 * heuristic, JSON extraction). The live model path (planSpawn → omp --smol) is
 * exercised end to end via the daemon, not here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assemblePlan, discoverRepos, MIN_EDGE, MIN_SAMPLES, parsePlanJson, pickRepoHeuristic, slug, type OutcomesReader } from "../src/smart-spawn.ts";
import type { ModelOutcomeCounts } from "../src/model-outcomes.ts";

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

// ── Outcome-driven model default (Epic 6 concern 07) ────────────────────────────────────────────

describe("assemblePlan — outcome-driven model default shift", () => {
	const candidates = ["/x/omp-squad"];
	const cwd = "/x/omp-squad";

	function outcomesFrom(map: Record<string, ModelOutcomeCounts>): OutcomesReader {
		return (model, tier) => map[`${model}::${tier}`] ?? { landed: 0, rejected: 0 };
	}

	test("flag off (default): no shift even with a strongly-winning candidate", () => {
		const outcomes = outcomesFrom({ "opus::heavy": { landed: 8, rejected: 0 }, "default::heavy": { landed: 1, rejected: 9 } });
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { outcomes });
		expect(plan.model).toBeUndefined();
	});

	test("flag on + >= MIN_SAMPLES + edge cleared: shifts to the better-landing model and appends a reason", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes = outcomesFrom({ "opus::heavy": { landed: 7, rejected: 1 }, "default::heavy": { landed: 1, rejected: 7 } }); // opus 0.875, default 0.125 → edge 0.75 >> 0.15
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { outcomes });
		expect(plan.model).toBe("opus");
		expect(plan.reason).toContain("model shifted to opus");
		expect(plan.reason).toContain("heavy");
	});

	test(`flag on but a candidate has fewer than MIN_SAMPLES (${MIN_SAMPLES}) total outcomes: no shift (cold, not eligible to win)`, () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes = outcomesFrom({ "opus::heavy": { landed: 3, rejected: 0 }, "default::heavy": { landed: 1, rejected: 9 } }); // opus has only 3 samples < 8
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { outcomes });
		expect(plan.model).toBeUndefined();
	});

	test(`flag on but the edge is below MIN_EDGE (${MIN_EDGE}): no shift, default stands`, () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes = outcomesFrom({ "opus::heavy": { landed: 5, rejected: 3 }, "default::heavy": { landed: 5, rejected: 4 } }); // opus 0.625 vs default 0.556 → edge ~0.07 < 0.15
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { outcomes });
		expect(plan.model).toBeUndefined();
	});

	test("an explicit LLM-supplied model is NEVER overridden, even with a winning candidate available", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes = outcomesFrom({ "opus::heavy": { landed: 8, rejected: 0 }, "default::heavy": { landed: 0, rejected: 8 } });
		const plan = assemblePlan("do it", candidates, cwd, { model: "sonnet", thinking: "high" }, { outcomes });
		expect(plan.model).toBe("sonnet");
	});

	test("no outcomes reader injected: no shift even with the flag on", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" });
		expect(plan.model).toBeUndefined();
	});

	test("a cold candidate is never starved below the baseline — an undecided shift just leaves the default untouched", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// Neither candidate has enough samples: the shift must be a pure no-op, never an implicit demotion.
		const outcomes = outcomesFrom({ "opus::mid": { landed: 1, rejected: 0 }, "default::mid": { landed: 0, rejected: 0 } });
		const plan = assemblePlan("do it", candidates, cwd, {}, { outcomes });
		expect(plan.model).toBeUndefined();
	});

	test("(S1 regression) a fat winner vs a COLD/unseen incumbent yields NO shift — the incumbent floor is symmetric with the winner's", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// opus clears MIN_SAMPLES (8) at a mediocre 0.25 land rate; "default" was NEVER measured ({0,0}).
		// Trusting the incumbent's unmeasured 0% rate would flip EVERY mid-tier omitted-model spawn to
		// opus (0.25 - 0 = 0.25 >= MIN_EDGE) despite opus's own poor record — starving the cold incumbent.
		const outcomes = outcomesFrom({ "opus::mid": { landed: 2, rejected: 6 }, "default::mid": { landed: 0, rejected: 0 } });
		const plan = assemblePlan("do it", candidates, cwd, {}, { outcomes });
		expect(plan.model).toBeUndefined(); // cold incumbent ⇒ no basis for comparison ⇒ base heuristic stands
	});

	test("(S1 regression) a thinly-measured incumbent (below MIN_SAMPLES) also blocks the shift", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		// opus: 8 samples @ 0.875; default: only 3 samples (below the floor) — even a strong winner must wait.
		const outcomes = outcomesFrom({ "opus::heavy": { landed: 7, rejected: 1 }, "default::heavy": { landed: 3, rejected: 0 } });
		const plan = assemblePlan("do it", candidates, cwd, { thinking: "high" }, { outcomes });
		expect(plan.model).toBeUndefined();
	});

	test("record/read bucketing agree: a 'medium'/undefined thinking task reads the 'mid' tier", () => {
		process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
		const outcomes = outcomesFrom({ "opus::mid": { landed: 8, rejected: 0 }, "default::mid": { landed: 0, rejected: 8 } });
		const plan = assemblePlan("do it", candidates, cwd, {}, { outcomes }); // no thinking ⇒ tierOf(undefined) === "mid"
		expect(plan.model).toBe("opus");
	});
});
