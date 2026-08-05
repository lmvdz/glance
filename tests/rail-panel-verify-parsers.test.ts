/**
 * A5 (T5 gauntlet round 2, glance#333) — the REAL claim-verification parsers, not just the injected-fake
 * call-site logic round 1 tested.
 *
 * Round 1's A5 fix only touched `runPanelUncoalesced`'s handling of an injected fake returning
 * `undefined`. The bug actually lived one layer down, in the parser itself: `parseVerifyConfirmed`
 * mapped the literal string `"inconclusive"` to `false` — indistinguishable from a genuine `"refuted"` —
 * so a model that faithfully answered "inconclusive" (exactly what `PANEL_VERIFY_SYSTEM` asks it to say
 * when it can't tell) got queued as a FABRICATED refutation. Round 1 also shipped ONE generic parser for
 * every harness's verify output (`extractJsonObject(raw)?.verdict`), which only ever matches plain `omp`
 * stdout — codex's real JSONL event-stream output and grok's `--json-schema` envelope both silently
 * failed to parse, so cross-lineage verification ALWAYS degraded to "unavailable" in production without
 * ever failing a test (round 1 only exercised verification through injected fakes).
 *
 * These tests drive the REAL parsers (`parseVerifyPlain`/`parseVerifyCodex`/`parseVerifyGrok`) against
 * realistic output shapes, mirroring `tests/validator-codex.test.ts`/`tests/validator-grok.test.ts`'s
 * own fixture conventions for the review-verdict parsers.
 */

import { expect, test } from "bun:test";
import { parseVerifyCodex, parseVerifyGrok, parseVerifyPlain } from "../src/rail/panel.ts";

// ── parseVerifyPlain (omp) ───────────────────────────────────────────────────────────────────────

test("parseVerifyPlain: confirmed -> true", () => {
	expect(parseVerifyPlain(JSON.stringify({ verdict: "confirmed" }))).toBe(true);
});

test("parseVerifyPlain: refuted -> false", () => {
	expect(parseVerifyPlain(JSON.stringify({ verdict: "refuted" }))).toBe(false);
});

test("A5 THE BUG: parseVerifyPlain: inconclusive -> undefined, NEVER false", () => {
	const r = parseVerifyPlain(JSON.stringify({ verdict: "inconclusive" }));
	expect(r).toBeUndefined();
	expect(r).not.toBe(false);
});

test("parseVerifyPlain: garbage/unknown verdict string -> undefined (never guessed)", () => {
	expect(parseVerifyPlain(JSON.stringify({ verdict: "maybe" }))).toBeUndefined();
});

test("parseVerifyPlain: missing verdict field entirely -> undefined", () => {
	expect(parseVerifyPlain(JSON.stringify({ notVerdict: "confirmed" }))).toBeUndefined();
});

test("parseVerifyPlain: unparseable garbage -> undefined, never throws", () => {
	expect(parseVerifyPlain("not json at all")).toBeUndefined();
	expect(parseVerifyPlain("")).toBeUndefined();
});

// ── parseVerifyCodex (JSONL event stream) ───────────────────────────────────────────────────────

function codexAgentMessage(text: string): string {
	return JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: text } });
}

test("parseVerifyCodex: plain single-object stdout (no event framing) parses", () => {
	expect(parseVerifyCodex(JSON.stringify({ verdict: "confirmed" }))).toBe(true);
});

test("parseVerifyCodex: verdict embedded in an agent_message JSONL event parses", () => {
	const stream = [
		JSON.stringify({ type: "session_meta", payload: { session_id: "s1", cwd: "/x" } }),
		JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
		codexAgentMessage(`Here is my verdict:\n${JSON.stringify({ verdict: "refuted" })}`),
	].join("\n");
	expect(parseVerifyCodex(stream)).toBe(false);
});

test("A5 THE BUG (real parser, codex shape): an embedded 'inconclusive' JSONL event -> undefined, NEVER false", () => {
	const stream = [
		JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
		codexAgentMessage(`After reviewing, I cannot substantiate this claim either way:\n${JSON.stringify({ verdict: "inconclusive" })}`),
	].join("\n");
	const r = parseVerifyCodex(stream);
	expect(r).toBeUndefined();
	expect(r).not.toBe(false);
});

test("parseVerifyCodex: verdict as its own JSONL line (no wrapper) parses", () => {
	const stream = [JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }), JSON.stringify({ verdict: "confirmed" })].join("\n");
	expect(parseVerifyCodex(stream)).toBe(true);
});

test("parseVerifyCodex: verdict in an item.text field (alternate codex shape) parses", () => {
	const stream = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `final: ${JSON.stringify({ verdict: "refuted" })}` } });
	expect(parseVerifyCodex(stream)).toBe(false);
});

test("parseVerifyCodex: no parseable verdict anywhere -> undefined, never throws", () => {
	expect(parseVerifyCodex("")).toBeUndefined();
	expect(parseVerifyCodex("codex: rate limited, try again")).toBeUndefined();
	expect(parseVerifyCodex([JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }), JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })].join("\n"))).toBeUndefined();
});

test("parseVerifyCodex: the LAST usable line wins when multiple candidate lines appear", () => {
	const stream = [codexAgentMessage(JSON.stringify({ verdict: "confirmed" })), codexAgentMessage(JSON.stringify({ verdict: "refuted" }))].join("\n");
	expect(parseVerifyCodex(stream)).toBe(false);
});

// ── parseVerifyGrok (--json-schema envelope) ────────────────────────────────────────────────────

/** The real shape: `grok -p --json-schema` pretty-prints an envelope around the structured result —
 *  mirrors tests/validator-grok.test.ts's own fixture builder verbatim. */
function envelope(v: unknown, opts: { withStructured?: boolean; withText?: boolean } = {}): string {
	const { withStructured = true, withText = true } = opts;
	const obj: Record<string, unknown> = { stopReason: "EndTurn", sessionId: "019f480c-c1ac-7a60-ba40-dc6aec7a1d9e", thought: "Checking the claim.\n" };
	if (withText) obj.text = JSON.stringify(v);
	if (withStructured) obj.structuredOutput = v;
	return JSON.stringify(obj, null, 2); // pretty-printed, multi-line — as grok actually emits
}

test("parseVerifyGrok: structuredOutput is taken directly (the --json-schema happy path)", () => {
	expect(parseVerifyGrok(envelope({ verdict: "confirmed" }))).toBe(true);
});

test("A5 THE BUG (real parser, grok shape): structuredOutput.verdict === 'inconclusive' -> undefined, NEVER false", () => {
	const r = parseVerifyGrok(envelope({ verdict: "inconclusive" }));
	expect(r).toBeUndefined();
	expect(r).not.toBe(false);
});

test("parseVerifyGrok: falls back to the text mirror when structuredOutput is absent", () => {
	expect(parseVerifyGrok(envelope({ verdict: "refuted" }, { withStructured: false }))).toBe(false);
});

test("parseVerifyGrok: the envelope may itself BE the verdict (no schema, plain --output-format)", () => {
	expect(parseVerifyGrok(JSON.stringify({ verdict: "confirmed" }))).toBe(true);
});

test("parseVerifyGrok: no parseable verdict anywhere -> undefined, never throws", () => {
	expect(parseVerifyGrok("")).toBeUndefined();
	expect(parseVerifyGrok(envelope({ notVerdict: true }))).toBeUndefined();
});

test("ROUND 1 REGRESSION GUARD: the single generic top-level-only parser round 1 shipped would have missed grok's nested structuredOutput.verdict entirely", () => {
	// Simulates round 1's bug directly: looking for `verdict` at the envelope's OWN top level (where it
	// never lives for a real grok --json-schema run) instead of inside `structuredOutput`.
	const raw = envelope({ verdict: "confirmed" });
	const topLevelOnly = (JSON.parse(raw) as Record<string, unknown>).verdict;
	expect(topLevelOnly).toBeUndefined(); // proves the OLD generic parser's lookup would have failed here
	expect(parseVerifyGrok(raw)).toBe(true); // the FIXED parser correctly finds it nested
});
