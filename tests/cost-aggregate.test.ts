/**
 * Lane-keyed O(1) cost aggregate (adw-factory-borrows concern 08): incremental write updates the
 * right cells, tumbling-window expiry, rebuild-from-receipts equals a live incremental replay, and
 * the lane -> lane-agnostic fallback ladder DESIGN.md prescribes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildCostAggregateFromReceipts,
	type CostAggregateDoc,
	costAggregateNeedsRebuild,
	COST_AGGREGATE_SCHEMA_VERSION,
	COST_AGGREGATE_WINDOW_MS,
	persistCostAggregateDoc,
	projectFromCostAggregate,
	readCostAggregateDoc,
	recordCostAttempt,
	recordCostLanded,
} from "../src/cost-aggregate.ts";
import type { ModelOutcomes } from "../src/model-outcomes.ts";
import type { RunReceipt } from "../src/types.ts";

const tmps: string[] = [];
function tmp(): string {
	const d = mkdtempSync(path.join(os.tmpdir(), "cost-aggregate-"));
	tmps.push(d);
	return d;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
function receipt(overrides: Partial<RunReceipt> & Pick<RunReceipt, "startedAt">): RunReceipt {
	seq++;
	return {
		agentId: `ag${seq}`,
		name: `run${seq}`,
		repo: "/repo",
		runId: `r${seq}`,
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		filesTouched: [],
		...overrides,
	};
}

describe("recordCostAttempt", () => {
	test("updates the lane-keyed cell AND the lane-agnostic roll-up", () => {
		const dir = tmp();
		const now = Date.now();
		recordCostAttempt(dir, "opus", "heavy", "hotfix", 1.5, now);
		recordCostAttempt(dir, "opus", "heavy", "hotfix", 2.5, now + 1000);

		const doc = readCostAggregateDoc(dir);
		expect(doc.schemaVersion).toBe(COST_AGGREGATE_SCHEMA_VERSION);
		const laneCell = doc.cells["opus::heavy::hotfix"];
		expect(laneCell).toBeDefined();
		expect(laneCell.attempts).toBe(2);
		expect(laneCell.costUsdSum).toBeCloseTo(4, 10);
		expect(laneCell.landed).toBe(0);

		const rollupCell = doc.cells["opus::heavy::*"];
		expect(rollupCell).toBeDefined();
		expect(rollupCell.attempts).toBe(2);
		expect(rollupCell.costUsdSum).toBeCloseTo(4, 10);
	});

	test("a DIFFERENT lane for the same (model, tier) gets its own cell but shares the roll-up", () => {
		const dir = tmp();
		const now = Date.now();
		recordCostAttempt(dir, "sonnet", "mid", "feature", 1, now);
		recordCostAttempt(dir, "sonnet", "mid", "chore", 2, now);

		const doc = readCostAggregateDoc(dir);
		expect(doc.cells["sonnet::mid::feature"].attempts).toBe(1);
		expect(doc.cells["sonnet::mid::chore"].attempts).toBe(1);
		expect(doc.cells["sonnet::mid::*"].attempts).toBe(2);
		expect(doc.cells["sonnet::mid::*"].costUsdSum).toBeCloseTo(3, 10);
	});

	test("undefined tier buckets under the literal 'unknown' key, never colliding with a real tier", () => {
		const dir = tmp();
		recordCostAttempt(dir, "opus", undefined, "feature", 1, Date.now());
		const doc = readCostAggregateDoc(dir);
		expect(doc.cells["opus::unknown::feature"]).toBeDefined();
		expect(doc.cells["opus::heavy::feature"]).toBeUndefined();
		expect(doc.cells["opus::mid::feature"]).toBeUndefined();
	});

	test("undefined lane only writes the roll-up cell (no double count)", () => {
		const dir = tmp();
		recordCostAttempt(dir, "opus", "light", undefined, 5, Date.now());
		const doc = readCostAggregateDoc(dir);
		expect(doc.cells["opus::light::*"].attempts).toBe(1);
		expect(doc.cells["opus::light::*"].costUsdSum).toBeCloseTo(5, 10);
	});
});

describe("recordCostLanded", () => {
	test("increments landed on the lane cell and the roll-up, leaving attempts/cost untouched", () => {
		const dir = tmp();
		const now = Date.now();
		recordCostAttempt(dir, "opus", "heavy", "hotfix", 10, now);
		recordCostLanded(dir, "opus", "heavy", "hotfix", now + 100);

		const doc = readCostAggregateDoc(dir);
		expect(doc.cells["opus::heavy::hotfix"].landed).toBe(1);
		expect(doc.cells["opus::heavy::hotfix"].attempts).toBe(1);
		expect(doc.cells["opus::heavy::hotfix"].costUsdSum).toBeCloseTo(10, 10);
		expect(doc.cells["opus::heavy::*"].landed).toBe(1);
	});
});

describe("window expiry (tumbling, not sliding)", () => {
	test("a write past COST_AGGREGATE_WINDOW_MS since windowStart resets the cell instead of extending it", () => {
		const dir = tmp();
		const t0 = Date.now();
		recordCostAttempt(dir, "opus", "mid", "feature", 3, t0);
		expect(readCostAggregateDoc(dir).cells["opus::mid::feature"].attempts).toBe(1);

		// Just under the window: still extends the SAME window.
		recordCostAttempt(dir, "opus", "mid", "feature", 3, t0 + COST_AGGREGATE_WINDOW_MS - 1);
		expect(readCostAggregateDoc(dir).cells["opus::mid::feature"].attempts).toBe(2);

		// At/over the window since the ORIGINAL windowStart: resets to a fresh window of 1.
		recordCostAttempt(dir, "opus", "mid", "feature", 3, t0 + COST_AGGREGATE_WINDOW_MS + 1);
		const cell = readCostAggregateDoc(dir).cells["opus::mid::feature"];
		expect(cell.attempts).toBe(1);
		expect(cell.windowStart).toBe(t0 + COST_AGGREGATE_WINDOW_MS + 1);
	});

	test("a stale cell (no write since it went stale) reads as ABSENT via projectFromCostAggregate, not as stale-forever data", () => {
		const t0 = Date.now() - COST_AGGREGATE_WINDOW_MS - 1;
		const doc: CostAggregateDoc = {
			schemaVersion: COST_AGGREGATE_SCHEMA_VERSION,
			generatedAt: t0,
			cells: { "opus::heavy::hotfix": { attempts: 50, landed: 40, costUsdSum: 500, windowStart: t0 } },
		};
		// Read "now": the window fully elapsed since windowStart with no intervening write.
		const proj = projectFromCostAggregate(doc, "opus", "heavy", "hotfix", 5, Date.now());
		expect(proj).toBeUndefined();
	});
});

describe("rebuild from receipts equals incremental state (property test)", () => {
	const MODELS = ["opus", "sonnet"] as const;
	const TIERS = ["light", "mid", "heavy"] as const;
	const LANES = ["hotfix", "feature", "chore"] as const;

	// Deterministic PRNG (mulberry32) so a failure is reproducible without pinning literal fixtures.
	function mulberry32(seed: number): () => number {
		let a = seed;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	for (let run = 0; run < 5; run++) {
		test(`replay #${run}: rebuild(receipts) cells === sequential recordCostAttempt cells`, () => {
			const rand = mulberry32(1000 + run);
			const n = 15 + Math.floor(rand() * 15);
			const dir = tmp();
			const receipts: RunReceipt[] = [];
			let ts = Date.now() - 10 * 24 * 60 * 60 * 1000; // start 10 days back, well inside one window
			for (let i = 0; i < n; i++) {
				ts += Math.floor(rand() * 6 * 60 * 60 * 1000); // up to 6h apart, strictly increasing
				const model = MODELS[Math.floor(rand() * MODELS.length)];
				const tier = TIERS[Math.floor(rand() * TIERS.length)];
				const lane = LANES[Math.floor(rand() * LANES.length)];
				const costUsd = Math.round(rand() * 1000) / 100;
				receipts.push(receipt({ startedAt: ts, endedAt: ts, model, tier, lane }));
			}
			// Incremental: feed the SAME sequence, in the SAME order, through the live write path.
			for (const r of receipts) recordCostAttempt(dir, r.model, r.tier, r.lane, r.costUsd ?? 0, r.endedAt ?? r.startedAt);
			const incremental = readCostAggregateDoc(dir).cells;

			// Bulk: the pure rebuild over the exact same receipts (no outcomes ⇒ no landed overlay,
			// matching the fact recordCostAttempt above never touches `landed` either).
			const rebuilt = buildCostAggregateFromReceipts(receipts, {}).cells;

			expect(Object.keys(rebuilt).sort()).toEqual(Object.keys(incremental).sort());
			for (const key of Object.keys(incremental)) {
				expect(rebuilt[key].attempts).toBe(incremental[key].attempts);
				expect(rebuilt[key].landed).toBe(incremental[key].landed);
				expect(rebuilt[key].costUsdSum).toBeCloseTo(incremental[key].costUsdSum, 6);
				expect(rebuilt[key].windowStart).toBe(incremental[key].windowStart);
			}
		});
	}

	test("a receipt sequence that crosses the window boundary still matches (exercises the reset branch during replay)", () => {
		const dir = tmp();
		const t0 = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days back: guarantees at least one reset
		const receipts: RunReceipt[] = [
			receipt({ startedAt: t0, endedAt: t0, model: "opus", tier: "heavy", lane: "hotfix", costUsd: 1 }),
			receipt({ startedAt: t0 + 5 * 24 * 60 * 60 * 1000, endedAt: t0 + 5 * 24 * 60 * 60 * 1000, model: "opus", tier: "heavy", lane: "hotfix", costUsd: 2 }),
			// 35 days after the FIRST event ⇒ past the 30-day window since windowStart ⇒ resets.
			receipt({ startedAt: t0 + 35 * 24 * 60 * 60 * 1000, endedAt: t0 + 35 * 24 * 60 * 60 * 1000, model: "opus", tier: "heavy", lane: "hotfix", costUsd: 4 }),
		];
		for (const r of receipts) recordCostAttempt(dir, r.model, r.tier, r.lane, r.costUsd ?? 0, r.endedAt ?? r.startedAt);
		const incremental = readCostAggregateDoc(dir).cells["opus::heavy::hotfix"];
		// Reset happened: only the LAST event survives the window.
		expect(incremental.attempts).toBe(1);
		expect(incremental.costUsdSum).toBeCloseTo(4, 10);

		const rebuilt = buildCostAggregateFromReceipts(receipts, {}).cells["opus::heavy::hotfix"];
		expect(rebuilt).toEqual(incremental);
	});
});

describe("rebuild overlays lane-agnostic `landed` from the existing model-outcomes ledger", () => {
	test("a (model,tier) roll-up cell with cost data gets its landed count from ModelOutcomes", () => {
		const receipts: RunReceipt[] = [
			receipt({ startedAt: Date.now(), endedAt: Date.now(), model: "opus", tier: "heavy", lane: "feature", costUsd: 10 }),
			receipt({ startedAt: Date.now(), endedAt: Date.now(), model: "opus", tier: "heavy", lane: "chore", costUsd: 20 }),
		];
		const outcomes: ModelOutcomes = { "opus::heavy": { landed: 7, rejected: 3 } };
		const doc = buildCostAggregateFromReceipts(receipts, outcomes);
		// The outcomes ledger is ALL-TIME but this doc's attempts are windowed: the overlay clamps
		// landed to the window's attempts (2 here), else landRate > 1.0 undercounts
		// costPerLandedChange — an under-deny skew once enforce reads these cells.
		expect(doc.cells["opus::heavy::*"].landed).toBe(2);
		// Lane-keyed cells are untouched by the overlay — only the roll-up gets it (no per-lane landed
		// signal exists yet; see cost-aggregate.ts's rollout note).
		expect(doc.cells["opus::heavy::feature"].landed).toBe(0);
		expect(doc.cells["opus::heavy::chore"].landed).toBe(0);
	});

	test("a (model,tier) with NO cost data gets no landed count attached (nothing to divide it against)", () => {
		const outcomes: ModelOutcomes = { "sonnet::light": { landed: 5, rejected: 1 } };
		const doc = buildCostAggregateFromReceipts([], outcomes);
		expect(doc.cells["sonnet::light::*"]).toBeUndefined();
	});
});

describe("lane fallback ladder (DESIGN.md: lane-keyed cell, else lane-agnostic roll-up, else silent)", () => {
	function doc(cells: CostAggregateDoc["cells"]): CostAggregateDoc {
		return { schemaVersion: COST_AGGREGATE_SCHEMA_VERSION, generatedAt: Date.now(), cells };
	}

	test("a sufficiently-sampled lane cell answers directly", () => {
		const d = doc({ "opus::heavy::hotfix": { attempts: 10, landed: 8, costUsdSum: 80, windowStart: Date.now() } });
		const proj = projectFromCostAggregate(d, "opus", "heavy", "hotfix", 5);
		expect(proj).toBeDefined();
		expect(proj?.source).toBe("lane");
		expect(proj?.sample).toBe(10);
		expect(proj?.costPerLandedChange).toBeCloseTo(10, 10);
	});

	test("a THIN lane cell falls back to a sufficiently-sampled roll-up", () => {
		const d = doc({
			"opus::heavy::chore": { attempts: 2, landed: 0, costUsdSum: 4, windowStart: Date.now() }, // below minSample
			"opus::heavy::*": { attempts: 20, landed: 15, costUsdSum: 150, windowStart: Date.now() },
		});
		const proj = projectFromCostAggregate(d, "opus", "heavy", "chore", 5);
		expect(proj?.source).toBe("rollup");
		expect(proj?.sample).toBe(20);
		expect(proj?.costPerLandedChange).toBeCloseTo(10, 10);
	});

	test("both lane and roll-up thin ⇒ silent (undefined), matching the existing thin-history posture", () => {
		const d = doc({
			"opus::heavy::chore": { attempts: 1, landed: 0, costUsdSum: 1, windowStart: Date.now() },
			"opus::heavy::*": { attempts: 2, landed: 0, costUsdSum: 2, windowStart: Date.now() },
		});
		expect(projectFromCostAggregate(d, "opus", "heavy", "chore", 5)).toBeUndefined();
	});

	test("no lane supplied ⇒ goes straight to the roll-up", () => {
		const d = doc({ "sonnet::mid::*": { attempts: 6, landed: 3, costUsdSum: 30, windowStart: Date.now() } });
		const proj = projectFromCostAggregate(d, "sonnet", "mid", undefined, 5);
		expect(proj?.source).toBe("rollup");
	});

	test("zero landed on the answering cell ⇒ costPerLandedChange is null, not Infinity/NaN", () => {
		const d = doc({ "opus::heavy::hotfix": { attempts: 10, landed: 0, costUsdSum: 80, windowStart: Date.now() } });
		const proj = projectFromCostAggregate(d, "opus", "heavy", "hotfix", 5);
		expect(proj?.costPerLandedChange).toBeNull();
	});
});

describe("costAggregateNeedsRebuild", () => {
	test("true on a missing doc, false after a write", () => {
		const dir = tmp();
		expect(costAggregateNeedsRebuild(dir)).toBe(true);
		recordCostAttempt(dir, "opus", "mid", "feature", 1, Date.now());
		expect(costAggregateNeedsRebuild(dir)).toBe(false);
	});

	test("true on a corrupt file", () => {
		const dir = tmp();
		persistCostAggregateDoc(dir, { schemaVersion: COST_AGGREGATE_SCHEMA_VERSION, generatedAt: Date.now(), cells: {} });
		expect(costAggregateNeedsRebuild(dir)).toBe(false);
		// Corrupt it directly on disk.
		writeFileSync(path.join(dir, "cost-aggregate.json"), "{not json");
		expect(costAggregateNeedsRebuild(dir)).toBe(true);
	});

	test("true on a schema-version mismatch", () => {
		const dir = tmp();
		persistCostAggregateDoc(dir, { schemaVersion: 999, generatedAt: Date.now(), cells: {} });
		expect(costAggregateNeedsRebuild(dir)).toBe(true);
	});
});
