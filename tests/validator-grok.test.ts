/**
 * Cross-lineage review (plans/cross-lineage-review/ concern 05) — the grok disjoint-judge parser.
 *
 * grok is the THIRD lineage (xAI), uncorrelated with both the Anthropic author and the OpenAI codex
 * judge. It is OFF by default (opt in via OMP_SQUAD_VALIDATOR_HARNESS=grok) and, like codex, these unit
 * tests only pin the PARSER against grok's real output shapes — they are NOT the live gate.
 *
 * Unlike codex, grok is invoked with `--json-schema`, which CONSTRAINS the model to the verdict shape
 * and returns one pretty-printed envelope carrying both a parsed `structuredOutput` and a `text` mirror.
 * The envelope below is verbatim from a live `grok -p … --json-schema` run (v0.2.93) — that pretty
 * multi-line framing is exactly why a line-by-line scan (codex's strategy) must NOT be used here.
 */

import { expect, test } from "bun:test";
import { parseCodexVerdict, parseGrokVerdict } from "../src/validator.ts";

const VERDICT = { perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: false, note: "auth missing" }], confidence: 0.8, rationale: "one criterion unmet" };

/** The real shape: `grok -p --json-schema` pretty-prints an envelope around the structured result. */
function envelope(v: unknown, opts: { withStructured?: boolean; withText?: boolean } = {}): string {
	const { withStructured = true, withText = true } = opts;
	const obj: Record<string, unknown> = { stopReason: "EndTurn", sessionId: "019f480c-c1ac-7a60-ba40-dc6aec7a1d9e", thought: "The user wants a verdict.\n" };
	if (withText) obj.text = JSON.stringify(v);
	if (withStructured) obj.structuredOutput = v;
	return JSON.stringify(obj, null, 2); // pretty-printed, multi-line — as grok actually emits
}

test("structuredOutput is taken directly (the --json-schema happy path)", () => {
	const r = parseGrokVerdict(envelope(VERDICT));
	expect(r?.perCriterion).toEqual([
		{ id: "c1", satisfied: true, note: undefined },
		{ id: "c2", satisfied: false, note: "auth missing" },
	]);
	expect(r?.confidence).toBe(0.8);
	expect(r?.rationale).toBe("one criterion unmet");
});

test("falls back to the `text` mirror when structuredOutput is absent", () => {
	const r = parseGrokVerdict(envelope(VERDICT, { withStructured: false }));
	expect(r?.perCriterion.map((c) => c.id)).toEqual(["c1", "c2"]);
	expect(r?.confidence).toBe(0.8);
});

test("a bare verdict object (no envelope) still parses — plain stdout, no schema", () => {
	const r = parseGrokVerdict(JSON.stringify(VERDICT));
	expect(r?.perCriterion.map((c) => c.satisfied)).toEqual([true, false]);
});

test("the multi-line pretty envelope parses (codex's line-by-line strategy would return undefined here)", () => {
	// The real regression this pins: if someone ever routes grok through `parseCodexVerdict`, the pretty
	// envelope yields nothing. Assert the CONTRAST directly rather than restating the helper's framing.
	const raw = envelope(VERDICT);
	expect(parseCodexVerdict(raw)?.perCriterion).toBeUndefined();
	expect(parseGrokVerdict(raw)?.perCriterion).toHaveLength(2);
});

test("an envelope with no usable verdict abstains (undefined), never fabricates a pass", () => {
	// A refusal / empty turn: envelope present, but nothing verdict-shaped inside.
	expect(parseGrokVerdict(envelope({ nope: true }))).toBeUndefined();
	expect(parseGrokVerdict(envelope("I cannot judge this diff.", { withStructured: false }))).toBeUndefined();
});

test("garbage, prose, and empty output all abstain rather than throw", () => {
	expect(parseGrokVerdict("")).toBeUndefined();
	expect(parseGrokVerdict("Sure! Here's my review: the diff looks fine to me.")).toBeUndefined();
	expect(parseGrokVerdict("{ not json at all")).toBeUndefined();
	// A structuredOutput whose perCriterion is the wrong TYPE must not coerce into a pass.
	expect(parseGrokVerdict(envelope({ perCriterion: "all good", confidence: 1 }))).toBeUndefined();
});

test("a verdict nested in structuredOutput wins over a stale/contradictory text mirror", () => {
	// If the two ever disagree, structuredOutput is the schema-constrained source of truth.
	const raw = JSON.stringify({ text: JSON.stringify({ perCriterion: [{ id: "stale", satisfied: true }] }), structuredOutput: VERDICT }, null, 2);
	expect(parseGrokVerdict(raw)?.perCriterion.map((c) => c.id)).toEqual(["c1", "c2"]);
});
