/**
 * Drift lens (Sentinel v0 MONITOR, plans/sentinel-drift-probe/01) — the action-free pure surface.
 * No LLM call happens in this file; `parseDriftHypothesis` is exercised directly against canned
 * model output, mirroring how tests/scout.test.ts drives `parseTickets`.
 */

import { afterEach, expect, test } from "bun:test";
import {
	buildDriftPrompt,
	DEFAULT_SENTINEL_MAX_CALLS_PER_HOUR,
	newSentinelCallBudget,
	parseDriftHypothesis,
	sentinelEnabled,
	sentinelMaxCallsPerHour,
} from "../src/drift-lens.ts";
import { ScoutCallBudget, scoutMaxCallsPerHour } from "../src/scout.ts";
import type { FeatureCriterion } from "../src/types.ts";

const ENV_KEYS = ["OMP_SQUAD_SENTINEL", "OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const CRITERIA: FeatureCriterion[] = [
	{ id: "c1", text: "adds retry to the RPC client", completed: false },
	{ id: "c2", text: "covers the reconnect path with a test", completed: false },
];

// ── buildDriftPrompt ─────────────────────────────────────────────────────────

test("buildDriftPrompt grounds the prompt in the declared criteria and tail-slices long reasoning", () => {
	const long = `stale-head ${"filler ".repeat(3000)}the tail conclusion is here`;
	const prompt = buildDriftPrompt("fix the RPC reconnect bug", CRITERIA, long);
	expect(prompt).toContain("adds retry to the RPC client");
	expect(prompt).toContain("covers the reconnect path with a test");
	expect(prompt).toContain("fix the RPC reconnect bug");
	expect(prompt).toContain("the tail conclusion is here"); // tail survives the slice
	expect(prompt).not.toContain("stale-head"); // head is sliced away past MAX_TEXT
	expect(prompt.toLowerCase()).toContain("drift");
});

test("buildDriftPrompt handles no task and no criteria", () => {
	const prompt = buildDriftPrompt(undefined, [], "some reasoning");
	expect(prompt).toContain("(unspecified)");
	expect(prompt).toContain("(none declared)");
});

// ── parseDriftHypothesis ─────────────────────────────────────────────────────

test("on-track reasoning ({\"drift\":null}) ⇒ parseDriftHypothesis returns null", () => {
	expect(parseDriftHypothesis('{"drift":null}', { agent: "ag1" })).toBeNull();
});

test("junk / unparseable output ⇒ null", () => {
	expect(parseDriftHypothesis("no json here", { agent: "ag1" })).toBeNull();
	expect(parseDriftHypothesis("", { agent: "ag1" })).toBeNull();
});

test("drifting reasoning ⇒ a wrong-direction hypothesis with evidence + rationale, tolerant of fences", () => {
	const raw =
		"```json\n" +
		JSON.stringify({
			drift: {
				severity: "high",
				evidence: "I'll skip the reconnect test and just refactor the whole config loader instead",
				rationale: "abandoning the declared criteria to pursue an unrelated refactor",
			},
		}) +
		"\n```";
	const got = parseDriftHypothesis(raw, { agent: "rpc-agent", runId: "r-1", now: () => 42 });
	expect(got).toEqual({
		kind: "wrong-direction",
		severity: "high",
		agent: "rpc-agent",
		runId: "r-1",
		evidence: "I'll skip the reconnect test and just refactor the whole config loader instead",
		rationale: "abandoning the declared criteria to pursue an unrelated refactor",
		at: 42,
	});
});

test("missing evidence or rationale ⇒ null (never fabricates a hypothesis)", () => {
	expect(parseDriftHypothesis(JSON.stringify({ drift: { severity: "low", rationale: "off track" } }), { agent: "ag1" })).toBeNull();
	expect(parseDriftHypothesis(JSON.stringify({ drift: { severity: "low", evidence: "some excerpt" } }), { agent: "ag1" })).toBeNull();
	expect(parseDriftHypothesis(JSON.stringify({ drift: { severity: "low", evidence: "", rationale: "" } }), { agent: "ag1" })).toBeNull();
});

test("unknown / proto-chain severity coerces to \"low\" (own-value check, not `in`)", () => {
	const base = { evidence: "excerpt", rationale: "reason" };
	expect(parseDriftHypothesis(JSON.stringify({ drift: { ...base, severity: "extreme" } }), { agent: "ag1", now: () => 1 })?.severity).toBe("low");
	expect(parseDriftHypothesis(JSON.stringify({ drift: { ...base, severity: "toString" } }), { agent: "ag1", now: () => 1 })?.severity).toBe("low");
	expect(parseDriftHypothesis(JSON.stringify({ drift: { ...base } }), { agent: "ag1", now: () => 1 })?.severity).toBe("low");
	expect(parseDriftHypothesis(JSON.stringify({ drift: { ...base, severity: "medium" } }), { agent: "ag1", now: () => 1 })?.severity).toBe("medium");
});

// ── sentinelEnabled / sentinelMaxCallsPerHour ────────────────────────────────

test('sentinelEnabled() is false unless OMP_SQUAD_SENTINEL="1" (default OFF — inverse of Scout)', () => {
	delete process.env.OMP_SQUAD_SENTINEL;
	expect(sentinelEnabled()).toBe(false);
	process.env.OMP_SQUAD_SENTINEL = "0";
	expect(sentinelEnabled()).toBe(false);
	process.env.OMP_SQUAD_SENTINEL = "yes";
	expect(sentinelEnabled()).toBe(false);
	process.env.OMP_SQUAD_SENTINEL = "1";
	expect(sentinelEnabled()).toBe(true);
});

test("sentinelMaxCallsPerHour: default + env override + invalid fallback", () => {
	delete process.env.OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR;
	expect(sentinelMaxCallsPerHour()).toBe(DEFAULT_SENTINEL_MAX_CALLS_PER_HOUR);
	process.env.OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR = "7";
	expect(sentinelMaxCallsPerHour()).toBe(7);
	process.env.OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR = "nonsense";
	expect(sentinelMaxCallsPerHour()).toBe(DEFAULT_SENTINEL_MAX_CALLS_PER_HOUR);
	process.env.OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR = "0"; // 0 ⇒ unlimited (handled by the budget)
	expect(sentinelMaxCallsPerHour()).toBe(0);
});

// ── budget isolation ──────────────────────────────────────────────────────────

test("the sentinel call budget is a distinct instance from Scout's — consuming one never touches the other", () => {
	process.env.OMP_SQUAD_SENTINEL_MAX_CALLS_PER_HOUR = "1";
	process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR = "1";
	let clock = 1_000_000;
	const sentinelBudget = newSentinelCallBudget(() => clock);
	const scoutBudget = new ScoutCallBudget(scoutMaxCallsPerHour, () => clock);

	expect(sentinelBudget.tryConsume()).toBe(true);
	expect(sentinelBudget.used()).toBe(1);
	expect(scoutBudget.used()).toBe(0); // Scout's budget is untouched by the sentinel consuming its own

	expect(scoutBudget.tryConsume()).toBe(true);
	expect(scoutBudget.used()).toBe(1);
	expect(sentinelBudget.tryConsume()).toBe(false); // sentinel's own hour is already full, independent of scout's
	delete process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR;
});
