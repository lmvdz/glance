/**
 * Cross-lineage review (plans/cross-lineage-review/ concern 05) — the codex disjoint-judge parser.
 *
 * codex is OFF by default and gated on a LIVE-VERIFY step (run against real diffs with codex
 * installed+authed) before it may be trusted to gate. These unit tests only pin the STREAM-TOLERANT
 * parser against codex's known output shapes (from src/ingest/codex.ts) — they are NOT the live gate.
 */

import { expect, test } from "bun:test";
import { parseCodexVerdict } from "../src/validator.ts";

const VERDICT = { perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: false, note: "auth missing" }], confidence: 0.8, rationale: "one criterion unmet" };

test("plain stdout (single JSON object) parses", () => {
	const r = parseCodexVerdict(JSON.stringify(VERDICT));
	expect(r?.perCriterion).toEqual([
		{ id: "c1", satisfied: true, note: undefined },
		{ id: "c2", satisfied: false, note: "auth missing" },
	]);
	expect(r?.confidence).toBe(0.8);
});

test("JSONL event stream with the verdict embedded in an agent_message survives — the multi-object case the naive slice breaks on", () => {
	const stream = [
		JSON.stringify({ type: "session_meta", payload: { session_id: "s1", cwd: "/x" } }),
		JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
		JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: `Here is my verdict:\n${JSON.stringify(VERDICT)}` } }),
		JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10 } } } }),
	].join("\n");
	const r = parseCodexVerdict(stream);
	expect(r?.perCriterion.map((p) => p.satisfied)).toEqual([true, false]);
});

test("verdict emitted as its own JSONL line (no event wrapper) parses", () => {
	const stream = [
		JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
		JSON.stringify(VERDICT),
	].join("\n");
	expect(parseCodexVerdict(stream)?.confidence).toBe(0.8);
});

test("verdict in an item.text field (alternate codex shape) parses", () => {
	const stream = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `final: ${JSON.stringify(VERDICT)}` } });
	expect(parseCodexVerdict(stream)?.perCriterion.length).toBe(2);
});

test("no parseable verdict anywhere ⇒ undefined (→ honest abstain, never a fabricated pass)", () => {
	expect(parseCodexVerdict("")).toBeUndefined();
	expect(parseCodexVerdict("codex: rate limited, try again")).toBeUndefined();
	expect(parseCodexVerdict([JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }), JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })].join("\n"))).toBeUndefined();
});

test("the last usable verdict wins when several appear (codex may restate)", () => {
	const first = { perCriterion: [{ id: "c1", satisfied: false }] };
	const stream = [
		JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: JSON.stringify(first) } }),
		JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: JSON.stringify(VERDICT) } }),
	].join("\n");
	const r = parseCodexVerdict(stream);
	expect(r?.perCriterion.length).toBe(2); // the final, complete verdict
});
