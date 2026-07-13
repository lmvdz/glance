/**
 * Baseline tracker (eap-borrows follow-up, concern 01 DESIGN decision 4) — the missing producer for
 * `omp-graph/task-class-matrix.ts`'s `detectBaselineStaleness` + `pinnedModel`. These tests exercise the
 * producer wiring directly (persist-then-compare, pin resolution, staleness on a rotted or vanished
 * cell) — `tests/membrane-breaker-cadence.test.ts` covers the one live production call site end to end.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
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

	test("a corrupt state file THROWS (corrupt-state) instead of being read as no prior selection (blind review finding #1)", async () => {
		// Mirrors convergence-oracle.ts#readFailures' fail-open finding #16 discipline: a corrupt sidecar
		// must escalate, never silently collapse into "nothing persisted yet" — that would silently
		// re-baseline against nothing on the very next round.
		const stateDir = await tmpDir();
		const file = path.join(stateDir, "baseline-tracker.json");
		await fs.writeFile(file, "{not json");
		expect(() => readPersistedBaseline(stateDir, "tdd:heavy")).toThrow(/corrupt-state/);
		// recordSelectedBaseline does a read-modify-write — it must ALSO throw rather than blindly
		// overwrite the corrupt file with a fresh single-entry state (which would destroy every OTHER
		// taskClass's persisted baseline sharing this file).
		expect(() => recordSelectedBaseline(stateDir, "tdd:heavy", "sonnet", 1000)).toThrow(/corrupt-state/);
		// The file on disk is left exactly as it was — never silently overwritten.
		expect(await fs.readFile(file, "utf8")).toBe("{not json");
	});

	test("a tracker entry with an invalid shape (a torn write) also THROWS corrupt-state", async () => {
		const stateDir = await tmpDir();
		const file = path.join(stateDir, "baseline-tracker.json");
		await fs.writeFile(file, JSON.stringify({ "tdd:heavy": { model: "sonnet" /* missing "at" — a plausible torn-write shape */ } }));
		expect(() => readPersistedBaseline(stateDir, "tdd:heavy")).toThrow(/corrupt-state/);
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

	test("a corrupt pin file THROWS (corrupt-state) instead of silently resolving to no pin (blind review finding #2)", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), "{not json");
		expect(() => resolvePinnedModel(stateDir, "tdd:heavy", {})).toThrow(/corrupt-state/);
	});

	test("an env pin that is SET but blank/whitespace-only THROWS (unparseable) rather than falling through silently", async () => {
		const stateDir = await tmpDir();
		const env = { OMP_SQUAD_BASELINE_PIN_TDD_HEAVY: "   " } as unknown as NodeJS.ProcessEnv;
		expect(() => resolvePinnedModel(stateDir, "tdd:heavy", env)).toThrow(/unparseable/);
	});

	test("a taskClass with no entry in an otherwise-valid pins file legitimately resolves to no pin (not corruption)", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:light": "opus" }));
		expect(resolvePinnedModel(stateDir, "tdd:heavy", {})).toBeUndefined();
	});

	// ── Round-2 review follow-up: a PRESENT but INVALID pin value must not silently read as "no pin" ────
	// (the same failure class as the blank-env-pin fix above — a silently-ignored pin is a
	// silently-disabled safety net). Only a genuinely ABSENT key (test above) stays silent.

	test("a pin value that is an empty string THROWS (unparseable), not silently 'no pin'", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "" }));
		expect(() => resolvePinnedModel(stateDir, "tdd:heavy", {})).toThrow(/unparseable/);
	});

	test("a pin value that is whitespace-only THROWS (unparseable), not silently 'no pin'", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "   " }));
		expect(() => resolvePinnedModel(stateDir, "tdd:heavy", {})).toThrow(/unparseable/);
	});

	test("a pin value that is a NUMBER (not a string) THROWS (unparseable), not silently 'no pin'", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": 42 }));
		expect(() => resolvePinnedModel(stateDir, "tdd:heavy", {})).toThrow(/unparseable/);
	});

	test("a pin value that is `null` THROWS (unparseable), not silently 'no pin'", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": null }));
		expect(() => resolvePinnedModel(stateDir, "tdd:heavy", {})).toThrow(/unparseable/);
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

	test("a pin pointing at an insufficientData cell fires a staleness event AND falls back to the auto-champion, never comparing against the ghost (blind review finding #2)", async () => {
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
		// A thin pin must not silently disable the compare (undefined baseline) nor keep comparing
		// against the ghost cell — it escalates (above) and falls back to the sample-sufficient
		// auto-champion explicitly.
		expect(result.baseline?.model).toBe("sonnet");
		expect(result.baseline?.pinned).toBe(false);
	});

	test("a pin naming a NONEXISTENT cell fires a staleness event AND falls back to the auto-champion, never silently disabling the compare (blind review finding #2)", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "grok" })); // never dispatched under this taskClass
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 9500 });
		expect(result.staleness).toHaveLength(1);
		expect(result.staleness[0].summary).toContain("grok");
		expect(result.staleness[0].detail).toMatch(/dropped out of the fleet|never dispatched/);
		expect(result.baseline?.model).toBe("sonnet");
		expect(result.baseline?.pinned).toBe(false);
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "sonnet", at: 9500 });
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

	// ── Blind review finding #1: corrupt tracker escalates, holds the measurement, never re-baselines ──

	test("a corrupt tracker file: escalation fired, baseline STILL resolves this round (never blocks the land), and the file is NEVER overwritten", async () => {
		const stateDir = await tmpDir();
		const file = path.join(stateDir, "baseline-tracker.json");
		await fs.writeFile(file, "{not json");
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 12000 });

		// 1. Escalation fired.
		expect(result.staleness.length).toBeGreaterThan(0);
		expect(result.staleness.some((e) => e.summary.toLowerCase().includes("corrupt") || e.detail.toLowerCase().includes("corrupt"))).toBe(true);
		expect(result.staleness.some((e) => e.summary.includes("tdd:heavy"))).toBe(true);

		// 2. The measurement is held, not blocked: a usable baseline still resolves off THIS round's doc
		//    (the pure `selectBaseline` computation never touched the corrupt file at all).
		expect(result.baseline?.model).toBe("sonnet");

		// 3. No silent re-baseline: the corrupt file on disk is untouched, left for a human to inspect —
		//    NOT overwritten with a fresh single-entry state.
		expect(await fs.readFile(file, "utf8")).toBe("{not json");
	});

	// ── Blind review finding #2: corrupt/bad pin escalates and falls back to the auto-champion ─────────

	test("a corrupt pin file: escalation fired and the auto-champion is used, never a crash or a silently-disabled compare", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), "{not json");
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 13000 });
		expect(result.staleness.length).toBeGreaterThan(0);
		expect(result.staleness.some((e) => e.summary.toLowerCase().includes("corrupt") || e.detail.toLowerCase().includes("corrupt"))).toBe(true);
		expect(result.baseline?.model).toBe("sonnet");
		expect(result.baseline?.pinned).toBe(false);
	});

	test("an env pin set but blank: escalation fired and the auto-champion is used", async () => {
		const stateDir = await tmpDir();
		const doc = healthyDoc("b", "sonnet");
		const env = { OMP_SQUAD_BASELINE_PIN_TDD_HEAVY: "" } as unknown as NodeJS.ProcessEnv;
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 13500, env });
		expect(result.staleness.some((e) => e.summary.toLowerCase().includes("corrupt") || e.detail.toLowerCase().includes("unparseable"))).toBe(true);
		expect(result.baseline?.model).toBe("sonnet");
	});

	// ── Round-2 review follow-up: a present-but-invalid pin VALUE inside a valid pins file ─────────────

	test("a pin file with a present-but-blank value for this taskClass: escalation fired and the auto-champion is used, not a silently-disabled compare", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": "" }));
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 13600 });
		expect(result.staleness.some((e) => e.summary.toLowerCase().includes("corrupt") || e.detail.toLowerCase().includes("unparseable"))).toBe(true);
		expect(result.baseline?.model).toBe("sonnet");
		expect(result.baseline?.pinned).toBe(false);
	});

	test("a pin file with a present-but-non-string value (a number) for this taskClass: escalation fired and the auto-champion is used", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:heavy": 42 }));
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 13700 });
		expect(result.staleness.some((e) => e.summary.toLowerCase().includes("corrupt") || e.detail.toLowerCase().includes("unparseable"))).toBe(true);
		expect(result.baseline?.model).toBe("sonnet");
		expect(result.baseline?.pinned).toBe(false);
	});

	test("a pin file with NO entry at all for this taskClass stays legitimately silent: no staleness, auto-champion used", async () => {
		const stateDir = await tmpDir();
		await fs.writeFile(path.join(stateDir, "baseline-pins.json"), JSON.stringify({ "tdd:light": "opus" }));
		const doc = healthyDoc("b", "sonnet");
		const result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 13800 });
		expect(result.staleness).toEqual([]);
		expect(result.baseline?.model).toBe("sonnet");
	});

	// ── Round-2 review follow-up: a write-time TOCTOU corruption must not drop the staleness array ──────

	test("recordSelectedBaseline throwing AFTER a healthy read (TOCTOU) is caught: staleness already built is still delivered, never lost to an uncaught throw", async () => {
		const stateDir = await tmpDir();
		// A prior baseline exists so this round has a real staleness event to lose if the throw escaped.
		recordSelectedBaseline(stateDir, "tdd:heavy", "opus", 1000); // pretend "opus" was last time's champion
		const doc = healthyDoc("b", "sonnet"); // this round's doc never saw "opus" — fires a staleness event

		// Simulate an external TOCTOU corruption landing between selectAndTrackBaseline's OWN healthy read
		// (readPersistedBaseline, the FIRST readFileSync call this invocation makes) and
		// recordSelectedBaseline's internal read-modify-write (the SECOND call): let the first call through
		// to the real implementation unchanged, then throw on the second — exactly what a foreign process
		// tearing the file mid-flight, between those two reads, would produce. Scoped to this one call and
		// restored immediately after (`finally`) — no other test observes the mock.
		const realReadFileSync = nodeFs.readFileSync;
		let calls = 0;
		const spy = spyOn(nodeFs, "readFileSync").mockImplementation((...args: Parameters<typeof nodeFs.readFileSync>) => {
			calls++;
			if (calls === 2) throw new Error("simulated TOCTOU corruption");
			return (realReadFileSync as (...a: unknown[]) => unknown)(...args);
		});
		let result!: ReturnType<typeof selectAndTrackBaseline>;
		try {
			expect(() => {
				result = selectAndTrackBaseline(stateDir, doc, "tdd:heavy", { now: 14000 });
			}).not.toThrow();
		} finally {
			spy.mockRestore();
		}

		// 1. The staleness event built BEFORE the write attempt (the vanished "opus" baseline) survived.
		expect(result.staleness.some((e) => e.summary.includes("opus"))).toBe(true);
		// 2. The write-time TOCTOU failure ALSO escalated via the same channel, not swallowed silently.
		expect(result.staleness.some((e) => e.summary.toLowerCase().includes("corrupt") || e.detail.toLowerCase().includes("toctou"))).toBe(true);
		// 3. The measurement itself is still returned — never fail-blocked on the write.
		expect(result.baseline?.model).toBe("sonnet");

		// Mock is fully torn down: a normal call afterward behaves exactly as before.
		expect(readPersistedBaseline(stateDir, "tdd:heavy")).toEqual({ model: "opus", at: 1000 });
	});
});
