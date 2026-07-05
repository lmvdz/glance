/**
 * Model-outcome ledger (Epic 6 concern 06): tierOf bucketing, modelKey normalization,
 * recordModelOutcome/modelOutcomes round-trip, corrupt-store and write-failure resilience.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modelKey, modelOutcomes, recordModelOutcome, tierOf } from "../src/model-outcomes.ts";
import type { ThinkingLevel } from "../src/types.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "model-outcomes-"));
}

describe("tierOf", () => {
	const cases: [ThinkingLevel | undefined, string][] = [
		["minimal", "light"],
		["low", "light"],
		["medium", "mid"],
		["high", "heavy"],
		["xhigh", "heavy"],
		[undefined, "mid"],
	];
	for (const [thinking, expected] of cases) {
		test(`${thinking ?? "undefined"} -> ${expected}`, () => {
			expect(tierOf(thinking)).toBe(expected);
		});
	}
});

describe("modelKey", () => {
	test("folds undefined/empty to 'default'", () => {
		expect(modelKey(undefined)).toBe("default");
		expect(modelKey("")).toBe("default");
		expect(modelKey("   ")).toBe("default");
	});
	test("trims and passes through a real model name", () => {
		expect(modelKey(" opus ")).toBe("opus");
	});
});

describe("recordModelOutcome / modelOutcomes", () => {
	test("bumps landed vs rejected independently per (model, tier)", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, "opus", "heavy", true);
			recordModelOutcome(dir, "opus", "heavy", true);
			recordModelOutcome(dir, "opus", "heavy", false);
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 2, rejected: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("different tiers for the same model are independent", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, "opus", "light", true);
			recordModelOutcome(dir, "opus", "heavy", false);
			expect(modelOutcomes(dir, "opus", "light")).toEqual({ landed: 1, rejected: 0 });
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 0, rejected: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an undefined model folds to 'default' and accumulates there", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, undefined, "mid", true);
			recordModelOutcome(dir, "  ", "mid", true);
			expect(modelOutcomes(dir, undefined, "mid")).toEqual({ landed: 2, rejected: 0 });
			expect(modelOutcomes(dir, "default", "mid")).toEqual({ landed: 2, rejected: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unseen (model, tier) key reads as {landed:0, rejected:0}, never throws", () => {
		const dir = tmp();
		try {
			expect(modelOutcomes(dir, "sonnet", "light")).toEqual({ landed: 0, rejected: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a corrupt ledger file reads as empty rather than throwing", () => {
		const dir = tmp();
		try {
			writeFileSync(path.join(dir, "model-outcomes.json"), "{not valid json");
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 0, rejected: 0 });
			// A subsequent record still works (start-fresh, not wedged).
			recordModelOutcome(dir, "opus", "heavy", true);
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 1, rejected: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a write failure is swallowed (best-effort) — never throws", () => {
		const dir = tmp();
		try {
			chmodSync(dir, 0o500); // read+execute only — writeFileSync inside should fail silently
			expect(() => recordModelOutcome(dir, "opus", "heavy", true)).not.toThrow();
		} finally {
			chmodSync(dir, 0o700);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
