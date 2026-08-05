/**
 * Golden coverage for `LandReceiptSchema` (glance#337, rail T9 gauntlet round 1 CRITICAL fix,
 * src/rail/wedge/receipt-schema.ts) — the decode that replaced scripts/post-wedge-check.ts's bare
 * `JSON.parse(...) as LandReceipt` cast. A well-formed receipt decodes; a malformed one fails closed
 * (rejected, never silently coerced).
 */
import { expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { LandReceiptSchema, type LandReceipt } from "../src/rail/index.ts";

function validReceiptJson(): unknown {
	return {
		repo: "acme/widgets",
		branch: "codex/fix",
		commit: "f".repeat(40),
		message: "fix the bug",
		files: ["src/foo.ts"],
		insertions: 5,
		deletions: 1,
		landed: true,
		at: 1_722_800_000_000,
		gate: { status: "green", command: "bun run check", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false, detail: "verified" },
		validation: {
			verdict: "pass",
			agreement: 1,
			confidence: 0.9,
			perCriterion: [{ id: "c1", satisfied: true }],
			rationale: "all good",
			model: "sonnet-5",
			ranAt: 1_722_800_000_000,
		},
		rollbackPoint: "0".repeat(40),
		forcedWithoutProof: false,
		cost: { costUsd: 0.42, costUnknown: false, model: "sonnet-5", tokens: 1000 },
	};
}

test("a well-formed receipt decodes successfully and round-trips the load-bearing fields", () => {
	const r = Schema.decodeUnknownResult(LandReceiptSchema)(validReceiptJson());
	expect(Result.isSuccess(r)).toBe(true);
	if (!Result.isSuccess(r)) throw new Error("unreachable");
	expect(r.success.repo).toBe("acme/widgets");
	expect(r.success.commit).toBe("f".repeat(40));
	expect(r.success.gate.status).toBe("green");
	expect(r.success.landed).toBe(true);
});

test("a receipt with the minimal required fields (no optional ones) decodes", () => {
	const minimal = {
		repo: "acme/widgets",
		branch: "codex/fix",
		files: [],
		landed: false,
		at: 1_722_800_000_000,
		gate: { status: "failed", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false },
		forcedWithoutProof: false,
		cost: { costUnknown: true },
	};
	const r = Schema.decodeUnknownResult(LandReceiptSchema)(minimal);
	expect(Result.isSuccess(r)).toBe(true);
});

test("an unknown gate.status literal fails decode — fail-closed, not coerced to a known value", () => {
	const bad = { ...validReceiptJson(), gate: { ...(validReceiptJson() as { gate: object }).gate, status: "totally-made-up-status" } };
	const r = Schema.decodeUnknownResult(LandReceiptSchema)(bad);
	expect(Result.isFailure(r)).toBe(true);
});

test("landed as a string instead of boolean fails decode", () => {
	const bad = { ...validReceiptJson(), landed: "true" };
	const r = Schema.decodeUnknownResult(LandReceiptSchema)(bad);
	expect(Result.isFailure(r)).toBe(true);
});

test("a missing required field (repo) fails decode", () => {
	const bad = validReceiptJson() as Record<string, unknown>;
	delete bad.repo;
	const r = Schema.decodeUnknownResult(LandReceiptSchema)(bad);
	expect(Result.isFailure(r)).toBe(true);
});

test("a completely unrelated JSON shape (e.g. an array, or a different object) fails decode", () => {
	expect(Result.isFailure(Schema.decodeUnknownResult(LandReceiptSchema)([1, 2, 3]))).toBe(true);
	expect(Result.isFailure(Schema.decodeUnknownResult(LandReceiptSchema)({ foo: "bar" }))).toBe(true);
	expect(Result.isFailure(Schema.decodeUnknownResult(LandReceiptSchema)("just a string"))).toBe(true);
	expect(Result.isFailure(Schema.decodeUnknownResult(LandReceiptSchema)(null))).toBe(true);
});

test("files must be an array of strings, not a single string or mixed types", () => {
	const bad1 = { ...validReceiptJson(), files: "src/foo.ts" };
	expect(Result.isFailure(Schema.decodeUnknownResult(LandReceiptSchema)(bad1))).toBe(true);
	const bad2 = { ...validReceiptJson(), files: ["src/foo.ts", 42] };
	expect(Result.isFailure(Schema.decodeUnknownResult(LandReceiptSchema)(bad2))).toBe(true);
});

test("a decoded receipt is usable as a real LandReceipt (type-level: assignable without a cast beyond the documented readonly-array re-narrow)", () => {
	const r = Schema.decodeUnknownResult(LandReceiptSchema)(validReceiptJson());
	if (!Result.isSuccess(r)) throw new Error("unreachable");
	const asReceipt = r.success as LandReceipt;
	expect(asReceipt.files).toEqual(["src/foo.ts"]);
});
