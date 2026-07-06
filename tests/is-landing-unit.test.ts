/**
 * Denominator honesty (Epic 6 concern 02): `isLandingUnit` decides which roster records belong in
 * the merge-rate denominator (kinds/roles/modes that never land by design must never read as false
 * failures) and `landingRosterOf` filters a roster down to that population.
 */

import { describe, expect, test } from "bun:test";
import { isLandingUnit, landingRosterOf, type LandingUnitCandidate } from "../src/is-landing-unit.ts";

describe("isLandingUnit", () => {
	test("a normal omp-operator coding unit lands", () => {
		expect(isLandingUnit({ kind: "omp-operator" })).toBe(true);
	});

	test("a workflow unit lands", () => {
		expect(isLandingUnit({ kind: "workflow" })).toBe(true);
	});

	test("a flue-service unit never lands (synthetic repo, no branch)", () => {
		expect(isLandingUnit({ kind: "flue-service" })).toBe(false);
	});

	test("an observer executionRole never lands (reproduce-and-report)", () => {
		expect(isLandingUnit({ kind: "omp-operator", executionRole: "observer" })).toBe(false);
	});

	test("a tester executionRole (tdd) still lands", () => {
		expect(isLandingUnit({ kind: "omp-operator", executionRole: "tester" })).toBe(true);
	});

	test("a by-design plan-only unit (static autonomyMode === observe) never lands", () => {
		expect(isLandingUnit({ kind: "omp-operator", autonomyMode: "observe" })).toBe(false);
	});

	test("an errored/blocked unit is NOT dropped from the denominator (keyed off static mode, not effectiveMode)", () => {
		// The bug this guards: effectiveMode collapses to "observe" whenever a blockedReason is set
		// (autonomy.ts), and blockedReason fires on dto.error/dto.pending. An errored, never-landed unit
		// is a REAL merge-rate failure and must stay counted. isLandingUnit reads the static autonomyMode,
		// so an autodrive unit that errored (live effectiveMode would be "observe") still counts as landing.
		const errored: LandingUnitCandidate = { kind: "omp-operator", autonomyMode: "autodrive" };
		expect(isLandingUnit(errored)).toBe(true);
	});

	test("assist/autodrive requested mode lands", () => {
		expect(isLandingUnit({ kind: "omp-operator", autonomyMode: "assist" })).toBe(true);
		expect(isLandingUnit({ kind: "omp-operator", autonomyMode: "autodrive" })).toBe(true);
	});

	test("a workflow synthesized observe verify-loop never lands", () => {
		expect(isLandingUnit({ kind: "workflow", workflow: { verify: { mode: "observe" } } })).toBe(false);
	});

	test("a workflow synthesized tdd/verify loop lands", () => {
		expect(isLandingUnit({ kind: "workflow", workflow: { verify: { mode: "tdd" } } })).toBe(true);
		expect(isLandingUnit({ kind: "workflow", workflow: { verify: { mode: "verify" } } })).toBe(true);
	});

	test("an adopted unit (re-adopted from a surviving worktree) still lands — adopted is not a kind/role/mode value", () => {
		// `adopted` lives only on AgentDTO/CreateAgentOptions, never on the fields isLandingUnit reads —
		// it falls through to true here unless one of the real exclusions also applies.
		expect(isLandingUnit({ kind: "omp-operator" })).toBe(true);
		expect(isLandingUnit({ kind: "workflow" })).toBe(true);
	});
});

describe("landingRosterOf", () => {
	test("filters a mixed roster down to only the landing-kind units", () => {
		const roster: LandingUnitCandidate[] = [
			{ kind: "omp-operator" }, // lands
			{ kind: "flue-service" }, // excluded
			{ kind: "omp-operator", executionRole: "observer" }, // excluded
			{ kind: "omp-operator", autonomyMode: "observe" }, // excluded (by-design plan-only)
			{ kind: "workflow", workflow: { verify: { mode: "observe" } } }, // excluded
			{ kind: "omp-operator", executionRole: "tester" }, // lands
			{ kind: "workflow" }, // lands
		];
		expect(landingRosterOf(roster)).toEqual([roster[0], roster[5], roster[6]]);
	});

	test("an empty roster filters to empty", () => {
		expect(landingRosterOf([])).toEqual([]);
	});
});
