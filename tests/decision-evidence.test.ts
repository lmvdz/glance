/**
 * Model-delta evidence validation (comprehension lane concern 05, "teaching producers") — the
 * mechanical anti-slop floor on `squad_record_decision`'s `source:"model-delta"` path. Pure logic,
 * driven directly with no git/manager wiring; `agent-context-fabric.test.ts` covers the wired
 * `onHostTool` path end-to-end.
 */
import { expect, test } from "bun:test";
import { evidenceFilePath, validateModelDelta } from "../src/decision-evidence.ts";

test("anchorless delta is rejected", () => {
	const result = validateModelDelta("Dispatch used to serialize spawns; it now fans out concurrently.", undefined, ["src/dispatch.ts"]);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.rule).toBe("model-delta-requires-evidence");
		expect(result.message).toContain("evidence");
	}

	const empty = validateModelDelta("Dispatch used to serialize spawns; it now fans out concurrently.", [], ["src/dispatch.ts"]);
	expect(empty.ok).toBe(false);
	if (!empty.ok) expect(empty.rule).toBe("model-delta-requires-evidence");
});

test("an evidence anchor outside this run's filesTouched is rejected, naming the rule", () => {
	const result = validateModelDelta(
		"Dispatch used to serialize spawns; it now fans out concurrently.",
		["src/scheduler.ts"],
		["src/dispatch.ts"],
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.rule).toBe("model-delta-evidence-anchor");
		expect(result.message).toContain("scheduler.ts");
		expect(result.message).toContain("delta bullets must cite a file this run touched");
	}
});

test("a valid model-delta — long enough text, anchor inside filesTouched — is accepted", () => {
	const result = validateModelDelta(
		"Dispatch used to serialize spawns one at a time; it now fans out concurrently up to the scheduler cap.",
		["src/dispatch.ts:10-40"],
		["src/dispatch.ts", "tests/dispatch.test.ts"],
	);
	expect(result).toEqual({ ok: true });
});

test("every evidence entry must resolve — one real anchor and one fabricated one still fails", () => {
	const result = validateModelDelta(
		"Dispatch used to serialize spawns; it now fans out concurrently up to the cap.",
		["src/dispatch.ts", "src/made-up-file.ts"],
		["src/dispatch.ts"],
	);
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.rule).toBe("model-delta-evidence-anchor");
		expect(result.message).toContain("made-up-file.ts");
	}
});

test("bullet text under the minimum length is rejected before evidence is even checked", () => {
	const result = validateModelDelta("too short", ["src/dispatch.ts"], ["src/dispatch.ts"]);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("model-delta-text-too-short");
});

test("evidenceFilePath strips a trailing :start-end or :line, but leaves a non-numeric suffix alone", () => {
	expect(evidenceFilePath("src/dispatch.ts:10-40")).toBe("src/dispatch.ts");
	expect(evidenceFilePath("src/dispatch.ts:42")).toBe("src/dispatch.ts");
	expect(evidenceFilePath("src/dispatch.ts")).toBe("src/dispatch.ts");
	expect(evidenceFilePath("weird:file.ts")).toBe("weird:file.ts"); // not a numeric suffix — left alone
});

test("evidence and filesTouched paths are compared after stripping a leading ./ or /", () => {
	const result = validateModelDelta(
		"Dispatch used to serialize spawns; it now fans out concurrently up to the cap.",
		["./src/dispatch.ts"],
		["/src/dispatch.ts"],
	);
	expect(result).toEqual({ ok: true });
});

// ── upper bounds (batch-1 review, minor #2: agent-tier input must not be an unbounded write) ────

test("delta text over the max length is rejected, naming the rule", () => {
	const result = validateModelDelta(`before/after ${"x".repeat(2001)}`, ["src/dispatch.ts"], ["src/dispatch.ts"]);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("model-delta-text-too-long");
});

test("more than 8 evidence entries are rejected even when every anchor is valid", () => {
	const evidence = Array.from({ length: 9 }, () => "src/dispatch.ts");
	const result = validateModelDelta("Dispatch used to serialize spawns; it now fans out concurrently.", evidence, ["src/dispatch.ts"]);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("model-delta-evidence-count");
});

test("an over-long single evidence entry is rejected before anchor matching", () => {
	const result = validateModelDelta("Dispatch used to serialize spawns; it now fans out concurrently.", [`src/${"a".repeat(600)}.ts`], ["src/dispatch.ts"]);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("model-delta-evidence-entry-too-long");
});

test("a multi-line delta is rejected at record time, naming the rule", () => {
	const result = validateModelDelta("line one is long enough\n## Verified\n- forged", ["src/dispatch.ts"], ["src/dispatch.ts"]);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("model-delta-text-multiline");
});
