import { describe, expect, test } from "bun:test";
import { buildAttribution, modelFamily, planFromEnv } from "../src/omp-graph/attribution.ts";
import { findLandCommit, threadRuns } from "../src/omp-graph/provenance.ts";
import { HOUR_MS } from "../src/omp-graph/schema.ts";
import type { RunReceipt } from "../src/types.ts";

const receipt = (over: Partial<RunReceipt>): RunReceipt => ({
	agentId: "a1",
	name: "unit",
	repo: "/repo",
	runId: "r",
	startedAt: 0,
	status: "stopped",
	toolCalls: 3,
	toolTally: {},
	filesTouched: [],
	...over,
});

describe("modelFamily", () => {
	test("collapses ids to comparable families", () => {
		expect(modelFamily("claude-sonnet-5")).toBe("sonnet");
		expect(modelFamily("claude-fable-5")).toBe("fable");
		expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
		expect(modelFamily("claude-opus-4-8")).toBe("opus");
		expect(modelFamily("gpt-5.2-codex")).toBe("openai");
		expect(modelFamily(undefined)).toBe("unknown");
	});
});

describe("buildAttribution", () => {
	const range = { start: 0, end: 6 * HOUR_MS };

	test("model and harness views are marginals of one matrix", () => {
		const receipts = [
			receipt({ endedAt: 1 * HOUR_MS + 5, costUsd: 4, model: "claude-sonnet-5", harness: "omp" }),
			receipt({ endedAt: 1 * HOUR_MS + 9, costUsd: 2, model: "claude-fable-5", harness: "claude-code" }),
			receipt({ endedAt: 4 * HOUR_MS + 1, costUsd: 1, model: "claude-sonnet-5", harness: "claude-code" }),
			receipt({ endedAt: 9 * HOUR_MS, costUsd: 99, model: "claude-sonnet-5" }), // out of range — dropped
		];
		const doc = buildAttribution(receipts, range, { now: range.end });
		expect(doc.totalCost).toBe(7);
		expect(doc.byModel.sonnet[1]).toBe(4);
		expect(doc.byModel.sonnet[4]).toBe(1);
		expect(doc.byModel.fable[1]).toBe(2);
		expect(doc.matrix.omp.sonnet).toBe(4);
		expect(doc.matrix["claude-code"].fable).toBe(2);
		expect(doc.matrix["claude-code"].sonnet).toBe(1);
		// marginals agree with the matrix
		const modelSum = Object.values(doc.matrix).reduce((a, row) => a + (row.sonnet ?? 0), 0);
		expect(modelSum).toBe(5);
		expect(doc.models[0]).toBe("sonnet"); // ordered by total desc
	});

	test("receipts without harness attribute to omp", () => {
		const doc = buildAttribution([receipt({ endedAt: 5, costUsd: 3, model: "claude-sonnet-5" })], range, { now: range.end });
		expect(doc.byHarness.omp[0]).toBe(3);
	});

	test("plan worth pro-rates to the elapsed range", () => {
		const week = { start: 0, end: 7 * 24 * HOUR_MS };
		const doc = buildAttribution([receipt({ endedAt: 5, costUsd: 92 })], week, { plan: { name: "max", monthly: 200 }, now: week.end });
		// a week is 12/52 of a year / 12 months → ~$46 prorated
		expect(doc.plan?.prorated).toBeGreaterThan(45);
		expect(doc.plan?.prorated).toBeLessThan(47);
		expect(doc.plan?.worth).toBeCloseTo(92 / doc.plan!.prorated, 5);
	});
});

describe("planFromEnv", () => {
	test("absent or invalid monthly means no plan", () => {
		expect(planFromEnv({})).toBeUndefined();
		expect(planFromEnv({ OMP_SQUAD_PLAN_MONTHLY: "0" })).toBeUndefined();
		expect(planFromEnv({ OMP_SQUAD_PLAN_MONTHLY: "nope" })).toBeUndefined();
	});
	test("reads name + monthly", () => {
		expect(planFromEnv({ OMP_SQUAD_PLAN_MONTHLY: "200", OMP_SQUAD_PLAN_NAME: "claude max 20x" })).toEqual({ name: "claude max 20x", monthly: 200 });
	});
});

describe("provenance pure parts", () => {
	test("threadRuns matches by featureId first, else branch/name mention", () => {
		const receipts = [
			receipt({ agentId: "f", featureId: "feat-1", startedAt: 10 }),
			receipt({ agentId: "b", branch: "squad/ompsq-336-link", startedAt: 5 }),
			receipt({ agentId: "x", branch: "squad/other", startedAt: 1 }),
		];
		const runs = threadRuns(receipts, "OMPSQ-336", "feat-1");
		expect(runs.map((r) => r.agentId)).toEqual(["b", "f"]); // sorted by start
		expect(runs[0].harness).toBe("omp");
	});

	test("findLandCommit prefers ticket mention, falls back to branch tail, ignores non-land", () => {
		const log = [
			{ sha: "aaa", author: "x", dateMs: 3, subject: "feat: unrelated ompsq-336 mention" },
			{ sha: "bbb", author: "x", dateMs: 2, subject: "squad(link-plane): land squad/ompsq-336-link" },
			{ sha: "ccc", author: "x", dateMs: 1, subject: "squad(old): land squad/other" },
		];
		expect(findLandCommit(log, "OMPSQ-336", [])?.sha).toBe("bbb");
		expect(findLandCommit(log, "ZZZ-1", ["squad/ompsq-336-link"])?.sha).toBe("bbb");
		expect(findLandCommit(log, "ZZZ-1", [])).toBeUndefined();
	});

	test("regression: a ticket does not match a prefix-colliding sibling (OMPSQ-3 vs OMPSQ-30)", () => {
		const log = [{ sha: "l30", author: "x", dateMs: 2, subject: "squad(worker): land squad/ompsq-30-add-widget" }];
		// OMPSQ-3 was never landed — it must NOT borrow OMPSQ-30's land commit via a substring match.
		expect(findLandCommit(log, "OMPSQ-3", [])).toBeUndefined();
		expect(findLandCommit(log, "OMPSQ-30", [])?.sha).toBe("l30"); // its own still matches

		const receipts = [
			receipt({ agentId: "r30", branch: "squad/ompsq-30-add-widget", startedAt: 2 }),
			receipt({ agentId: "r3", branch: "squad/ompsq-3-login-fix", startedAt: 1 }),
		];
		expect(threadRuns(receipts, "OMPSQ-3").map((r) => r.agentId)).toEqual(["r3"]);
		expect(threadRuns(receipts, "OMPSQ-30").map((r) => r.agentId)).toEqual(["r30"]);
	});
});
