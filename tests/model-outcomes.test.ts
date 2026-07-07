/**
 * Model-outcome ledger (Epic 6 concern 06; key-coherence research-sirvir/02): tierOf bucketing,
 * modelFamily normalization, recordModelOutcome/modelOutcomes round-trip, corrupt-store and
 * write-failure resilience, and the family-key migration fold for pre-existing ledgers.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MODEL_FAMILY, modelFamily, modelOutcomes, recordModelOutcome, recordModelOutcomeBlocked, tierOf } from "../src/model-outcomes.ts";
import { ROUTE_CHEAP_FAMILY } from "../src/model-route.ts";
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

describe("modelFamily (research-sirvir/02, key-coherence)", () => {
	test("DEFAULT_MODEL_FAMILY matches model-route.ts's ROUTE_CHEAP_FAMILY — a drift guard, not a coincidence", () => {
		// Two independently-declared constants name the SAME concept (the family an omitted model
		// resolves to). Kept as separate constants to avoid an import cycle (see DEFAULT_MODEL_FAMILY's
		// doc comment) — this test is what actually prevents them from silently diverging.
		expect(DEFAULT_MODEL_FAMILY).toBe(ROUTE_CHEAP_FAMILY);
	});

	test("empty/undefined resolves to DEFAULT_MODEL_FAMILY, NOT a phantom 'default' string", () => {
		expect(modelFamily(undefined)).toBe(DEFAULT_MODEL_FAMILY);
		expect(modelFamily("")).toBe(DEFAULT_MODEL_FAMILY);
		expect(modelFamily("   ")).toBe(DEFAULT_MODEL_FAMILY);
	});

	// Every raw model-identity shape actually observed on the fleet's real ledger
	// (plans/orchestration/reports/receipts-audit-2026-07-07.md section 3) must normalize to a
	// stable family, so a value recorded under any of these shapes is found by every other shape's
	// reader.
	test("round-trips every real on-disk shape from the receipts audit to its family", () => {
		expect(modelFamily("openai-codex/gpt-5.5")).toBe("openai");
		expect(modelFamily("gpt-5.5")).toBe("openai");
		expect(modelFamily("claude-opus-4-8")).toBe("opus");
		expect(modelFamily("opus")).toBe("opus");
		expect(modelFamily("claude-fable-5")).toBe("fable");
		expect(modelFamily("claude-sonnet-5")).toBe("sonnet");
		expect(modelFamily("claude-sonnet-4-6")).toBe("sonnet");
		expect(modelFamily(undefined)).toBe(DEFAULT_MODEL_FAMILY); // the `<missing>` shape, 422/543 receipts
	});

	test("a provider-qualified id folds to the SAME family as its bare/alias forms", () => {
		expect(modelFamily("anthropic/claude-opus-4-8")).toBe(modelFamily("opus"));
		expect(modelFamily("anthropic/claude-opus-4-8")).toBe(modelFamily("claude-opus-4-8"));
		expect(modelFamily("openai-codex/gpt-5.5")).toBe(modelFamily("gpt-5.5"));
	});

	test("trims whitespace around a real model name", () => {
		expect(modelFamily(" opus ")).toBe("opus");
	});

	test("fixed point: every real family name normalizes to itself (idempotent migration fold)", () => {
		for (const family of ["fable", "opus", "sonnet", "haiku", "openai", "gemini", "other"]) {
			expect(modelFamily(family)).toBe(family);
		}
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

	test("an undefined model folds to DEFAULT_MODEL_FAMILY and accumulates there", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, undefined, "mid", true);
			recordModelOutcome(dir, "  ", "mid", true);
			expect(modelOutcomes(dir, undefined, "mid")).toEqual({ landed: 2, rejected: 0 });
			expect(modelOutcomes(dir, DEFAULT_MODEL_FAMILY, "mid")).toEqual({ landed: 2, rejected: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("record must equal read: a provider/id model is recorded, then a bare-alias reader HITS it (not {0,0}) — the concern's core Verify", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, "anthropic/claude-opus-4-8", "heavy", true);
			// The candidate/incumbent path (smart-spawn's SHIFT_CANDIDATES, the scoreboard) only ever
			// knows the bare family alias — this is the exact read that was always {0,0} before this fix.
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 1, rejected: 0 });
			// And the reverse shape (a claude-code receipt's bare id) hits the same row too.
			expect(modelOutcomes(dir, "claude-opus-4-8", "heavy")).toEqual({ landed: 1, rejected: 0 });
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

describe("recordModelOutcomeBlocked (research-sirvir/01-recording-unlock, part 2)", () => {
	test("bumps its own `blocked` counter, independent of landed/rejected", () => {
		const dir = tmp();
		try {
			recordModelOutcomeBlocked(dir, "opus", "heavy");
			recordModelOutcomeBlocked(dir, "opus", "heavy");
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 0, rejected: 0, blocked: 2 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("never touches landed/rejected on an entry that already has real outcomes", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, "opus", "heavy", true);
			recordModelOutcome(dir, "opus", "heavy", false);
			recordModelOutcomeBlocked(dir, "opus", "heavy");
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 1, rejected: 1, blocked: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("landed/rejected recording after a blocked entry is unaffected by the blocked bucket", () => {
		const dir = tmp();
		try {
			recordModelOutcomeBlocked(dir, "opus", "heavy");
			recordModelOutcome(dir, "opus", "heavy", true);
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 1, rejected: 0, blocked: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an on-disk ledger written BEFORE `blocked` existed still parses; blocked lands on top of it", () => {
		const dir = tmp();
		try {
			// The exact old on-disk shape — no `blocked` key anywhere.
			writeFileSync(path.join(dir, "model-outcomes.json"), JSON.stringify({ "opus::heavy": { landed: 3, rejected: 1 } }));
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 3, rejected: 1 });
			recordModelOutcomeBlocked(dir, "opus", "heavy");
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 3, rejected: 1, blocked: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an entry that has ONLY ever landed/rejected has no `blocked` key at all — old-shape exact-equality is unaffected", () => {
		const dir = tmp();
		try {
			recordModelOutcome(dir, "opus", "heavy", true);
			// No recordModelOutcomeBlocked call for this key — the read must stay the exact old shape,
			// proving the new field is genuinely additive/optional, not defaulted-in everywhere.
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 1, rejected: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("different tiers for the same model are independent", () => {
		const dir = tmp();
		try {
			recordModelOutcomeBlocked(dir, "opus", "light");
			expect(modelOutcomes(dir, "opus", "light")).toEqual({ landed: 0, rejected: 0, blocked: 1 });
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 0, rejected: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an undefined model folds to DEFAULT_MODEL_FAMILY and accumulates there", () => {
		const dir = tmp();
		try {
			recordModelOutcomeBlocked(dir, undefined, "mid");
			recordModelOutcomeBlocked(dir, "  ", "mid");
			expect(modelOutcomes(dir, DEFAULT_MODEL_FAMILY, "mid")).toEqual({ landed: 0, rejected: 0, blocked: 2 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a write failure is swallowed (best-effort) — never throws", () => {
		const dir = tmp();
		try {
			chmodSync(dir, 0o500);
			expect(() => recordModelOutcomeBlocked(dir, "opus", "heavy")).not.toThrow();
		} finally {
			chmodSync(dir, 0o700);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("family-key migration (research-sirvir/02): old on-disk shapes fold into the new namespace, read-time, never losing counts", () => {
	test("two OLD raw-id keys for the same family merge into one read — no history dropped", () => {
		const dir = tmp();
		try {
			// The exact pre-migration shapes the receipts audit found: a provider/id key and a bare
			// alias key, both really "opus", previously two separate (never-colliding) ledger rows.
			writeFileSync(
				path.join(dir, "model-outcomes.json"),
				JSON.stringify({
					"claude-opus-4-8::heavy": { landed: 3, rejected: 1 },
					"opus::heavy": { landed: 2, rejected: 0 },
				}),
			);
			expect(modelOutcomes(dir, "opus", "heavy")).toEqual({ landed: 5, rejected: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the old phantom 'default' bucket-name key folds to DEFAULT_MODEL_FAMILY, not to the 'other' family", () => {
		const dir = tmp();
		try {
			writeFileSync(path.join(dir, "model-outcomes.json"), JSON.stringify({ "default::mid": { landed: 4, rejected: 2 } }));
			expect(modelOutcomes(dir, DEFAULT_MODEL_FAMILY, "mid")).toEqual({ landed: 4, rejected: 2 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a `blocked` count on an old-shape row survives the fold, and merges across colliding old keys", () => {
		const dir = tmp();
		try {
			writeFileSync(
				path.join(dir, "model-outcomes.json"),
				JSON.stringify({
					"openai-codex/gpt-5.5::mid": { landed: 1, rejected: 0, blocked: 2 },
					"gpt-5.5::mid": { landed: 0, rejected: 1, blocked: 1 },
				}),
			);
			expect(modelOutcomes(dir, "openai-codex/gpt-5.5", "mid")).toEqual({ landed: 1, rejected: 1, blocked: 3 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an already-family-keyed 'openai' row is stable across repeated reads (the fixed-point guard)", () => {
		const dir = tmp();
		try {
			writeFileSync(path.join(dir, "model-outcomes.json"), JSON.stringify({ "openai::light": { landed: 5, rejected: 1 } }));
			// Read twice — a naive re-derivation (rawModelFamily("openai") → "other") would corrupt the
			// row into a DIFFERENT family on the very first read.
			expect(modelOutcomes(dir, "openai", "light")).toEqual({ landed: 5, rejected: 1 });
			expect(modelOutcomes(dir, "openai", "light")).toEqual({ landed: 5, rejected: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("recording after reading a pre-migration ledger persists the folded shape (write-back side effect)", () => {
		const dir = tmp();
		try {
			writeFileSync(path.join(dir, "model-outcomes.json"), JSON.stringify({ "claude-opus-4-8::heavy": { landed: 3, rejected: 1 } }));
			recordModelOutcome(dir, "opus", "heavy", true); // same family, old-alias raw string
			expect(modelOutcomes(dir, "claude-opus-4-8", "heavy")).toEqual({ landed: 4, rejected: 1 });
			// The file on disk is now family-keyed — no leftover raw-id key remains under it.
			const onDisk = JSON.parse(readFileSync(path.join(dir, "model-outcomes.json"), "utf8"));
			expect(onDisk).toEqual({ "opus::heavy": { landed: 4, rejected: 1 } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
