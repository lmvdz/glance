/**
 * Baseline tracker (eap-borrows follow-up, concern 01 DESIGN decision 4) — the missing producer for
 * `omp-graph/task-class-matrix.ts`'s `detectBaselineStaleness` + `pinnedModel`. These tests exercise the
 * producer wiring directly (persist-then-compare, pin resolution, staleness on a rotted or vanished
 * cell) — `tests/membrane-breaker-cadence.test.ts` covers the one live production call site end to end.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readPersistedBaseline, recordSelectedBaseline, resolvePinnedModel, selectAndTrackBaseline } from "../src/baseline-tracker.ts";
import { buildTaskClassMatrix, type DenominatorUnit } from "../src/omp-graph/task-class-matrix.ts";
import { HOUR_MS } from "../src/omp-graph/schema.ts";
import type { TaskOutcomeRow } from "../src/task-outcomes.ts";

const range = { start: 0, end: 24 * HOUR_MS };

const row = (agentId: string, model: string, outcome: TaskOutcomeRow["outcome"]): TaskOutcomeRow => ({
	agentId,
	routing: { mode: "tdd", tier: "heavy" },
	model,
	outcome,
	source: "land",
	ts: HOUR_MS,
});

const unit = (agentId: string, model: string): DenominatorUnit => ({ agentId, taskClass: { mode: "tdd", tier: "heavy" }, model });

/** A healthy 5-unit "sonnet" cell — 4 landed, 1 rejected: sample-sufficient, not saturated. */
function healthyDoc(agentPrefix: string, model: string) {
	const ids = [1, 2, 3, 4, 5].map((i) => `${agentPrefix}${i}`);
	const rows = ids.map((id, i) => row(id, model, i < 4 ? "landed" : "rejected"));
	const denom = ids.map((id) => unit(id, model));
	return buildTaskClassMatrix(rows, denom, range);
}

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "baseline-tracker-"));
	tmps.push(dir);
	return dir;
}

describe("readPersistedBaseline / recordSelectedBaseline", () => {
	test("no prior selection ever made returns undefined", async () => {
		const stateDir = await tmpDir();
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toBeUndefined();
	});

	test("records and reads back the same model, keyed per taskClass", async () => {
		const stateDir = await tmpDir();
		recordSelectedBaseline(stateDir, "tdd:heavy", "sonnet", 1000);
		recordSelectedBaseline(stateDir, "tdd:light", "opus", 2000);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "sonnet", at: 1000 });
		expect(readPersistedBaseline(stateDir, "tdd:light")).toEqual({ model: "opus", at: 2000 });
	});

	test("a later selection for the SAME taskClass overwrites the prior one (only the most recent matters)", async () => {
		const stateDir = await tmpDir();
		recordSelectedBaseline(stateDir, "tdd:heavy", "sonnet", 1000);
		recordSelectedBaseline(stateDir, "tdd:heavy", "opus", 2000);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "opus", at: 2000 });
	});

	test("a corrupt state file is treated as no prior selection, not a crash", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-tracker.json"), "{not json");
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toBeUndefined();
		// and recording still works afterward (write path is independently best-effort)
		recordSelectedBaseline(stateDir, "tdd:heavy", "sonnet", 1000);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "sonnet", at: 1000 });
	});
});

describe("resolvePinnedModel", () => {
	test("no env var, no pin file ⇒ undefined", async () => {
		const stateDir = await tmpDir();
		expect(resolvePinnedModel(stateDir, "tdd:heavy", {})).toBeUndefined();
	});

	test("env var OMP_SQUAD_BASELINE_PIN_<TASKCLASS> wins, taskClass normalized to a safe env key", async () => {
		const stateDir = await tmpDir();
		const env = { OMP_SQUAD_BASELINE_PIN_TDD_HEAVY: "opus" } as unknown as NodeJS.ProcessEnv;
		expect(resolvePinnedModel(stateDir, "tdd:heavy", env)).toBe("opus");
	});

	test("pin file is honored when no env var is set", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "sonnet" }));
		expect(resolvePinnedModel(stateDir, "tdd:heavy", {})).toBe("sonnet");
	});

	test("env var wins over a conflicting pin file", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "sonnet" }));
		const env = { OMP_SQUAD_BASELINE_PIN_TDD_HEAVY: "opus" } as unknown as NodeJS.ProcessEnv;
		expect(resolvePinnedModel(stateDir, "tdd:heavy", env)).toBe("opus");
	});

	test("a corrupt pin file resolves to no pin, not a crash", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), "{not json");
		expect(resolvePinnedModel(stateDir, "tdd:heavy", {})).toBeUndefined();
	});
});

describe("selectAndTrackBaseline", () => {
	test("first-ever selection for a taskClass: no staleness (nothing persisted yet), and it persists what it picked", async () => {
		const stateDir = await tmpDir();
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 5000 });
		expect(result.staleness).toEqual([]);
		expect(result.baseline?.model).toBe("sonnet");
		expect(result.baseline?.pinned).toBe(false);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "sonnet", at: 5000 });
	});

	test("a previously-persisted baseline that VANISHED from the new doc fires a staleness event", async () => {
		const stateDir = await tmpDir();
		recordSelectedBaseline(stateDir, "tdd:heavy", "opus", 1000); // pretend "opus" was last time's champion
		const doc = healthyDoc("b", "sonnet"); // this round's doc never saw "opus" at all
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 6000 });
		expect(result.staleness).toHaveLength(1);
		expect(result.staleness[0].summary).toContain("opus");
		expect(result.staleness[0].summary).toContain("tdd:heavy");
		expect(result.staleness[0].detail).toMatch(/dropped out of the fleet|never dispatched/);
		// still resolves and persists a NEW baseline off the current doc — staleness reports, never blocks
		expect(result.baseline?.model).toBe("sonnet");
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "sonnet", at: 6000 });
	});

	test("a previously-persisted baseline that degraded to insufficientData fires a staleness event", async () => {
		const stateDir = await tmpDir();
		recordSelectedBaseline(stateDir, "tdd:heavy", "sonnet", 1000);
		// This round: only 2 "sonnet" units (below MIN_SAMPLES=3) plus a healthy sample-sufficient "opus" cell.
		const rows = [row("s1", "sonnet", "landed"), row("s2", "sonnet", "landed"), ...[1, 2, 3, 4, 5].map((i) => row(`o${i}`, "opus", i < 4 ? "landed" : "rejected"))];
		const denom = [unit("s1", "sonnet"), unit("s2", "sonnet"), ...[1, 2, 3, 4, 5].map((i) => unit(`o${i}`, "opus"))];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 7000 });
		expect(result.staleness).toHaveLength(1);
		expect(result.staleness[0].summary).toContain("sonnet");
		expect(result.staleness[0].detail).toMatch(/insufficient data/);
		// the new champion (opus, sample-sufficient) becomes the new baseline
		expect(result.baseline?.model).toBe("opus");
	});

	test("a healthy previously-persisted baseline (still sample-sufficient) fires NO staleness event", async () => {
		const stateDir = await tmpDir();
		recordSelectedBaseline(stateDir, "tdd:heavy", "sonnet", 1000);
		const doc = healthyDoc("b", "sonnet"); // same model, still healthy
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 8000 });
		expect(result.staleness).toEqual([]);
	});

	test("a pin pointing at an insufficientData cell fires a staleness event but still resolves the pinned baseline", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "opus" }));
		// "opus" only has 1 unit in this doc — thin, insufficientData.
		const rows = [row("o1", "opus", "landed"), ...[1, 2, 3, 4, 5].map((i) => row(`s${i}`, "sonnet", i < 4 ? "landed" : "rejected"))];
		const denom = [unit("o1", "opus"), ...[1, 2, 3, 4, 5].map((i) => unit(`s${i}`, "sonnet"))];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 9000 });
		expect(result.staleness).toHaveLength(1);
		expect(result.staleness[0].summary).toContain("opus");
		expect(result.staleness[0].detail).toMatch(/insufficient data/);
		// the pin still wins — selectBaseline doesn't silently fall back to the auto-champion
		expect(result.baseline?.model).toBe("opus");
		expect(result.baseline?.pinned).toBe(true);
	});

	test("a healthy pin fires no staleness and is recorded as the persisted baseline", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "opus" }));
		const doc = healthyDoc("o", "opus");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 10000 });
		expect(result.staleness).toEqual([]);
		expect(result.baseline?.model).toBe("opus");
		expect(result.baseline?.pinned).toBe(true);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "opus", at: 10000 });
	});

	test("no auto-champion and no pin: undefined baseline, no staleness, nothing persisted", async () => {
		const stateDir = await tmpDir();
		const rows = [row("s1", "sonnet", "landed"), row("s2", "sonnet", "landed")]; // below MIN_SAMPLES
		const denom = [unit("s1", "sonnet"), unit("s2", "sonnet")];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 11000 });
		expect(result.baseline).toBeUndefined();
		expect(result.staleness).toEqual([]);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toBeUndefined();
	});
});
