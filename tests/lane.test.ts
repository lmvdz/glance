/**
 * Lane taxonomy (adw-factory-borrows concern 01) — classifier fixtures for each lane + default, plus
 * the shadow log line format and the policy table's exhaustiveness.
 */

import { expect, test } from "bun:test";
import { classifyLane, laneFromRouted, LANE_POLICY, WORK_LANES, type WorkLane } from "../src/lane.ts";

// ── heuristic classification (no classify fn) ──────────────────────────────────────────────────

test("classifyLane: hotfix signals", async () => {
	for (const task of ["revert the broken prod migration", "hotfix the outage", "fix production bug in checkout", "regression in the payments flow", "broken main, needs an urgent fix"]) {
		const d = await classifyLane(task, "/repo");
		expect(d.lane).toBe("hotfix");
		expect(d.source).toBe("heuristic");
	}
});

test("classifyLane: chore signals", async () => {
	for (const task of ["bump the lodash dependency", "rename the helper function", "fix typo in README", "reformat the file", "dependency update for eslint"]) {
		const d = await classifyLane(task, "/repo");
		expect(d.lane).toBe("chore");
		expect(d.source).toBe("heuristic");
	}
});

test("classifyLane: no signal → feature default", async () => {
	const d = await classifyLane("add a new caching layer for the API", "/repo");
	expect(d.lane).toBe("feature");
	expect(d.source).toBe("default");
});

test("classifyLane: hotfix checked before chore when both signals present", async () => {
	const d = await classifyLane("revert the dependency bump that broke prod", "/repo");
	expect(d.lane).toBe("hotfix");
});

// ── LLM classification (injected classify; no real model) ──────────────────────────────────────

const classify = (json: string) => async () => json;

test("classifyLane (LLM): reads lane straight off a JSON response", async () => {
	const d = await classifyLane("do the thing", "/repo", classify('{"lane":"chore"}'));
	expect(d.lane).toBe("chore");
	expect(d.source).toBe("llm");
});

test("classifyLane (LLM): tolerates surrounding prose", async () => {
	const d = await classifyLane("do the thing", "/repo", classify('Sure!\n{"lane":"hotfix"}\nDone.'));
	expect(d.lane).toBe("hotfix");
});

test("classifyLane (LLM): unparseable/invalid lane falls back to heuristics", async () => {
	const unparseable = await classifyLane("bump the dependency", "/repo", classify("I cannot help with that."));
	expect(unparseable.lane).toBe("chore");
	expect(unparseable.source).toBe("heuristic");

	const invalidLane = await classifyLane("bump the dependency", "/repo", classify('{"lane":"urgent"}'));
	expect(invalidLane.lane).toBe("chore");
	expect(invalidLane.source).toBe("heuristic");
});

test("classifyLane (LLM): a throwing classify fn falls back to heuristics, never throws", async () => {
	const throwing = async () => {
		throw new Error("model unavailable");
	};
	const d = await classifyLane("revert the outage fix", "/repo", throwing);
	expect(d.lane).toBe("hotfix");
	expect(d.source).toBe("heuristic");
});

// ── laneFromRouted (shared JSON-field reader) ───────────────────────────────────────────────────

test("laneFromRouted: reads a valid lane, rejects invalid/absent values", () => {
	expect(laneFromRouted({ lane: "hotfix" })).toBe("hotfix");
	expect(laneFromRouted({ lane: "feature" })).toBe("feature");
	expect(laneFromRouted({ lane: "chore" })).toBe("chore");
	expect(laneFromRouted({ lane: "nonsense" })).toBeUndefined();
	expect(laneFromRouted({})).toBeUndefined();
	expect(laneFromRouted(undefined)).toBeUndefined();
});

// ── shadow log line ──────────────────────────────────────────────────────────────────────────

// ── LANE_POLICY exhaustiveness (clamp table) ────────────────────────────────────────────────────

test("LANE_POLICY: exactly the 3 WorkLane rows, all fields well-formed", () => {
	expect(WORK_LANES).toEqual(["hotfix", "feature", "chore"]);
	expect(Object.keys(LANE_POLICY).sort()).toEqual([...WORK_LANES].sort());
	for (const lane of WORK_LANES) {
		const policy = LANE_POLICY[lane];
		expect(typeof policy.modelRouteApply).toBe("boolean");
		expect(["shadow", "ask", "deny"]).toContain(policy.costAction);
		expect([0, 1]).toContain(policy.race);
	}
});

test("LANE_POLICY: every row ships shadow-first on model-route apply (no lane defaults to apply)", () => {
	for (const lane of WORK_LANES) {
		expect(LANE_POLICY[lane].modelRouteApply).toBe(false);
	}
});

// adw-factory-borrows concern 09 flips chore's costAction to "deny" (DESIGN.md's "chore lane first"
// rollout, once concern 08's lane-keyed aggregate exists to judge it fairly) — hotfix/feature stay
// shadow-first; this is the ONE named, evidence-gated exception the concern-01 module doc predicted
// ("Every non-shadow row is a later concern's named, evidence-gated flip").
test("LANE_POLICY: only chore's costAction has flipped past shadow — hotfix/feature stay shadow", () => {
	expect(LANE_POLICY.chore.costAction).toBe("deny");
	expect(LANE_POLICY.hotfix.costAction).toBe("shadow");
	expect(LANE_POLICY.feature.costAction).toBe("shadow");
});

test("LANE_POLICY: chore carries a low hard cost ceiling; hotfix carries a lower model-route edge floor", () => {
	expect(LANE_POLICY.chore.costCeilingUsd).toBeGreaterThan(0);
	expect(LANE_POLICY.chore.costCeilingUsd).toBeLessThanOrEqual(5);
	expect(LANE_POLICY.hotfix.modelRouteMinEdge).toBeLessThan(0.15); // below smart-spawn.ts's shared MIN_EDGE
	expect(LANE_POLICY.hotfix.race).toBe(1);
	expect(LANE_POLICY.feature.race).toBe(0);
	expect(LANE_POLICY.chore.race).toBe(0);
});

// TypeScript-level exhaustiveness: `Record<WorkLane, LanePolicy>` forces every union member to have a
// row — this compiles only because LANE_POLICY genuinely covers all three; adding a 4th WorkLane
// without a matching row here is a compile error, not a runtime surprise.
test("LANE_POLICY: type-level exhaustive switch compiles for every lane", () => {
	function policyFor(lane: WorkLane): string {
		switch (lane) {
			case "hotfix":
				return "hotfix-row";
			case "feature":
				return "feature-row";
			case "chore":
				return "chore-row";
		}
	}
	expect(WORK_LANES.map(policyFor)).toEqual(["hotfix-row", "feature-row", "chore-row"]);
});
