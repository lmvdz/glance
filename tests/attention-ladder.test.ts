/**
 * The needs-you ladder's pure cascade (t3-face concern 06, src/attention-ladder.ts): one
 * server-computed priority state per unit, ranked error > pending-approval > awaiting-input >
 * working > plan-ready > completed-unseen > idle. These pin the cascade order, the fail-closed
 * "missing visit ≠ seen" rule, and the max-priority roll-up the cockpit spine's group headers use.
 */

import { describe, expect, test } from "bun:test";
import { computeLadderPriority, maxLadderPriority, LADDER_RANK, type LadderCandidate } from "../src/attention-ladder.ts";
import type { PendingRequest } from "../src/types.ts";

function pending(overrides: Partial<PendingRequest> = {}): PendingRequest {
	return { id: "p1", source: "ui", kind: "confirm", title: "confirm?", createdAt: 0, ...overrides };
}

function unit(overrides: Partial<LadderCandidate> = {}): LadderCandidate {
	return { status: "idle", pending: [], ...overrides };
}

describe("computeLadderPriority: one state per unit, ranked cascade", () => {
	test("status 'error' outranks everything", () => {
		expect(computeLadderPriority(unit({ status: "error", pending: [pending({ gateClass: true })] }))).toBe("error");
	});

	test("a validator veto is 'error' even when status is idle and nothing is pending", () => {
		expect(computeLadderPriority(unit({ validation: { verdict: "veto", agreement: 0, confidence: 0, perCriterion: [], rationale: "", ranAt: 0 } }))).toBe("error");
	});

	test("a PR closed without merging is 'error' — distinct from 'merged'", () => {
		expect(computeLadderPriority(unit({ prState: "closed" }))).toBe("error");
		expect(computeLadderPriority(unit({ prState: "merged" }))).not.toBe("error");
	});

	test("a gateClass pending request is 'pending-approval', outranking a plain question", () => {
		expect(computeLadderPriority(unit({ status: "input", pending: [pending({ gateClass: true })] }))).toBe("pending-approval");
	});

	test("a pending request with no gateClass is 'awaiting-input'", () => {
		expect(computeLadderPriority(unit({ status: "input", pending: [pending({ gateClass: undefined })] }))).toBe("awaiting-input");
	});

	test("ANY gateClass pending among several outranks the rest — 'pending-approval' wins", () => {
		expect(computeLadderPriority(unit({ status: "input", pending: [pending({ id: "a" }), pending({ id: "b", gateClass: true })] }))).toBe("pending-approval");
	});

	test("'working' and 'starting' (t3's 'connecting') both map to the 'working' rung", () => {
		expect(computeLadderPriority(unit({ status: "working" }))).toBe("working");
		expect(computeLadderPriority(unit({ status: "starting" }))).toBe("working");
	});

	test("landReady is 'plan-ready', below working but above completed-unseen/idle", () => {
		expect(computeLadderPriority(unit({ status: "idle", landReady: true }))).toBe("plan-ready");
		// working still outranks a stale landReady flag from a PRIOR run
		expect(computeLadderPriority(unit({ status: "working", landReady: true }))).toBe("working");
	});

	test("idle with no completion at all is 'idle' — never 'completed-unseen' out of nothing", () => {
		expect(computeLadderPriority(unit({ status: "idle" }), {})).toBe("idle");
	});

	test("idle with a completion and no recorded visit is 'completed-unseen' (fail-closed default)", () => {
		expect(computeLadderPriority(unit({ status: "idle" }), { completedAt: 1_000 })).toBe("completed-unseen");
	});

	test("fail-closed: a MISSING completion signal is never coerced into 'seen' — absence of proof stays absent", () => {
		// No completedAt at all, even with a real visitedAt on file: there's nothing to have seen yet,
		// so this must read idle, not silently "completed-unseen" from a stale/wrong default either.
		expect(computeLadderPriority(unit({ status: "idle" }), { completedAt: undefined, visitedAt: 500 })).toBe("idle");
	});

	test("a visit strictly BEFORE the completion still reads unseen (the completion happened after)", () => {
		expect(computeLadderPriority(unit({ status: "idle" }), { completedAt: 2_000, visitedAt: 1_000 })).toBe("completed-unseen");
	});

	test("a visit AT OR AFTER the completion clears it to 'idle'", () => {
		expect(computeLadderPriority(unit({ status: "idle" }), { completedAt: 2_000, visitedAt: 2_000 })).toBe("idle");
		expect(computeLadderPriority(unit({ status: "idle" }), { completedAt: 2_000, visitedAt: 3_000 })).toBe("idle");
	});

	test("a 'stopped' unit with an unseen completion still reads completed-unseen (no dedicated rung, folds into the terminal pair)", () => {
		expect(computeLadderPriority(unit({ status: "stopped" }), { completedAt: 1_000 })).toBe("completed-unseen");
	});

	test("the full cascade order end-to-end, highest to lowest", () => {
		const cases: { input: LadderCandidate; signals?: { completedAt?: number; visitedAt?: number }; want: string }[] = [
			{ input: unit({ status: "error" }), want: "error" },
			{ input: unit({ status: "input", pending: [pending({ gateClass: true })] }), want: "pending-approval" },
			{ input: unit({ status: "input", pending: [pending()] }), want: "awaiting-input" },
			{ input: unit({ status: "working" }), want: "working" },
			{ input: unit({ status: "idle", landReady: true }), want: "plan-ready" },
			{ input: unit({ status: "idle" }), signals: { completedAt: 1 }, want: "completed-unseen" },
			{ input: unit({ status: "idle" }), want: "idle" },
		];
		for (const c of cases) expect(computeLadderPriority(c.input, c.signals)).toBe(c.want);
	});
});

describe("maxLadderPriority: the cockpit spine's per-project/per-daemon roll-up", () => {
	test("returns the single most urgent priority present in the group", () => {
		expect(maxLadderPriority(["idle", "working", "completed-unseen"])).toBe("working");
		expect(maxLadderPriority(["idle", "awaiting-input", "error"])).toBe("error");
	});

	test("an empty group reads as 'idle' — never throws, never undefined", () => {
		expect(maxLadderPriority([])).toBe("idle");
	});

	test("LADDER_RANK enumerates every rung, highest-urgency first, ending in 'idle'", () => {
		expect(LADDER_RANK[0]).toBe("error");
		expect(LADDER_RANK.at(-1)).toBe("idle");
		expect(LADDER_RANK.length).toBe(7);
	});
});
