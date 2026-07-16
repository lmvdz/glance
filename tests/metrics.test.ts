/**
 * Learning-loop metrics + flags (agentic-learning-loop concern 01): recordMetric ring/spool,
 * first-try-green derivation, and A/B variant stability.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearningMetrics, isFirstTryGreen, isOn, learningFlags, metricsPath, stableVariant } from "../src/metrics.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "learning-metrics-"));
}

const ENV_KEYS = ["OMP_SQUAD_REFLEXION", "OMP_SQUAD_REWARD_BOOST", "OMP_SQUAD_FAILURE_MEMORY", "OMP_SQUAD_MODEL_OUTCOMES"];
afterEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
});

describe("isFirstTryGreen", () => {
	test("true only when proof passed with zero fixup visits", () => {
		expect(isFirstTryGreen(true, 0)).toBe(true);
		expect(isFirstTryGreen(true, 1)).toBe(false);
		expect(isFirstTryGreen(false, 0)).toBe(false);
		expect(isFirstTryGreen(false, 2)).toBe(false);
	});
});

describe("learningFlags", () => {
	test("defaults every flag to off, except failureMemory which defaults on (skills-hardening concern 05)", () => {
		const f = learningFlags();
		expect(f.reflexion).toBe("off");
		expect(f.rewardBoost).toBe("off");
		expect(f.failureMemory).toBe("on");
		expect(f.modelOutcomes).toBe("off");
	});

	test('"1" resolves on regardless of id', () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		expect(learningFlags().reflexion).toBe("on");
		expect(learningFlags("agent-42").reflexion).toBe("on");
		expect(isOn(learningFlags().reflexion)).toBe(true);
	});

	test('"0" is the explicit off-switch for a default-on flag (failureMemory)', () => {
		process.env.OMP_SQUAD_FAILURE_MEMORY = "0";
		expect(learningFlags().failureMemory).toBe("off");
		expect(isOn(learningFlags().failureMemory)).toBe(false);
	});

	test("legacy boolean spellings keep meaning what the operator meant across a default flip", () => {
		// Before FLAG_DEFAULT existed, EVERY unrecognized value fell through to off — so `=false`/`=off`/
		// empty were all honored disables. A default flip to on must not silently override that intent.
		for (const off of ["false", "off", "no", "", " 0 ", "FALSE"]) {
			process.env.OMP_SQUAD_FAILURE_MEMORY = off;
			expect(learningFlags().failureMemory, `value ${JSON.stringify(off)} must disable`).toBe("off");
		}
		for (const on of ["true", "on", "yes", "1", "TRUE"]) {
			process.env.OMP_SQUAD_REFLEXION = on;
			expect(learningFlags().reflexion, `value ${JSON.stringify(on)} must enable`).toBe("on");
		}
	});

	test('"ab" hashes the id into a stable variant — same id always resolves the same way', () => {
		process.env.OMP_SQUAD_REWARD_BOOST = "ab";
		const first = learningFlags("agent-a1").rewardBoost;
		for (let i = 0; i < 5; i++) expect(learningFlags("agent-a1").rewardBoost).toBe(first);
		// Different ids CAN land on different arms (not asserted which, just that resolution is a function of id).
		expect(["on", "off"]).toContain(learningFlags("agent-b2").rewardBoost);
	});

	test("stableVariant is a pure function of (envVar, id)", () => {
		const a = stableVariant("OMP_SQUAD_REFLEXION", "x");
		const b = stableVariant("OMP_SQUAD_REFLEXION", "x");
		expect(a).toBe(b);
	});

	test("unrecognized env values fall back to the flag's own default (off for reflexion, on for failureMemory)", () => {
		process.env.OMP_SQUAD_REFLEXION = "yes-please";
		expect(learningFlags().reflexion).toBe("off");
		process.env.OMP_SQUAD_FAILURE_MEMORY = "yes-please";
		expect(learningFlags().failureMemory).toBe("on");
	});
});

describe("LearningMetrics", () => {
	test("record stamps strictly-increasing ids and rings the event", () => {
		const dir = tmp();
		try {
			const m = new LearningMetrics(dir, { log: () => {} });
			const a = m.record("first-try-green", 1, undefined, 1000);
			const b = m.record("first-try-green", 0, undefined, 1000); // same ms ⇒ id must still increase
			expect(b.id).toBeGreaterThan(a.id);
			expect(m.recent().length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("spools every sample to disk and hydrates the ring from it on restart", async () => {
		const dir = tmp();
		try {
			const m = new LearningMetrics(dir, { log: () => {} });
			m.record("escalation", 1, { flag: "reflexion", variant: "on" });
			m.record("fixups-to-green", 2);
			await Bun.sleep(30); // spool is fire-and-forget
			expect(existsSync(metricsPath(dir))).toBe(true);
			const lines = readFileSync(metricsPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(lines.map((e) => e.name)).toEqual(["escalation", "fixups-to-green"]);

			const restarted = new LearningMetrics(dir, { log: () => {} });
			expect(restarted.recent().length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a corrupt/torn trailing line is skipped on hydrate, not fatal", async () => {
		const dir = tmp();
		try {
			const m = new LearningMetrics(dir, { log: () => {} });
			m.record("primer-empty", 1);
			await Bun.sleep(20);
			const fs = await import("node:fs/promises");
			await fs.appendFile(metricsPath(dir), "{not json\n");
			const restarted = new LearningMetrics(dir, { log: () => {} });
			expect(restarted.recent().length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rollup aggregates count/sum/avg and breaks down by tag", () => {
		const dir = tmp();
		try {
			const m = new LearningMetrics(dir, { log: () => {} });
			m.record("first-try-green", 1, { flag: "reflexion", variant: "on" });
			m.record("first-try-green", 1, { flag: "reflexion", variant: "on" });
			m.record("first-try-green", 0, { flag: "reflexion", variant: "off" });
			const rows = m.rollup();
			const row = rows.find((r) => r.name === "first-try-green");
			expect(row?.count).toBe(3);
			expect(row?.sum).toBe(2);
			expect(row?.byTag?.variant?.on).toEqual({ count: 2, sum: 2, avg: 1 });
			expect(row?.byTag?.variant?.off).toEqual({ count: 1, sum: 0, avg: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rollup respects the trailing window", () => {
		const dir = tmp();
		try {
			const m = new LearningMetrics(dir, { log: () => {} });
			const now = 10_000_000;
			m.record("escalation", 1, undefined, now - 1000);
			m.record("escalation", 1, undefined, now - 90_000_000);
			const rows = m.rollup(3_600_000, now);
			expect(rows.find((r) => r.name === "escalation")?.count).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("record never throws even if the ring/spool machinery misbehaves", () => {
		const dir = tmp();
		try {
			const m = new LearningMetrics(dir, { log: () => {} });
			expect(() => m.record("land-failure-streak", 1)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
