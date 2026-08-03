import { expect, test } from "bun:test";
import type { DecisionRecord, NodeRecord } from "../src/memory/node-records.ts";
import { proposeRules } from "../src/rule-proposals.ts";
import { borrowedDefaults, coldStartLearningState, proposalSampleFloor, unknownLedger } from "../src/unknowns.ts";

const decision = (id: string): DecisionRecord => ({
	id,
	nodeId: "plan-1",
	createdAt: Number(id.slice(1)),
	kind: "decision",
	question: "Take the reversible option?",
	options: ["yes", "no"],
	chose: "yes",
	decidedBy: "human",
	askedAt: Number(id.slice(1)) * 1_000,
	decidedAt: Number(id.slice(1)) * 1_000 + 60_000,
	reason: "no-rule-applied",
});

test("cold start makes six borrowed defaults visible and individually reversible", () => {
	const state = coldStartLearningState("plan-1", 10);
	expect(state.borrowedDefaults).toHaveLength(6);
	expect(state.borrowedDefaults.every((rule) => rule.status === "borrowed" && rule.reversal.length > 0)).toBe(true);
	expect(state.outOfHoursContact).toBe("unset");
	expect(state.outOfHoursSentence).toBeUndefined();
	expect(borrowedDefaults.map((rule) => rule.id)).toEqual(state.borrowedDefaults.map((rule) => rule.id));
});

test("every unknown names the evidence, sample, and cost required to settle it", () => {
	for (const unknown of unknownLedger) {
		expect(unknown.settlingEvidence).not.toBe("");
		expect(unknown.requiredSampleSize).toBeGreaterThan(0);
		expect(unknown.costOfNotKnowing).not.toBe("");
	}
});

test("an unsettled ledger entry raises the rule proposal floor", () => {
	const learning = coldStartLearningState("plan-1", 1);
	const four = ["d1", "d2", "d3", "d4"].map(decision);
	expect(proposalSampleFloor([learning], "take the reversible option?")).toBe(5);
	expect(proposeRules([learning, ...four] as NodeRecord[])).toEqual([]);
	const proposals = proposeRules([learning, ...four, decision("d5")] as NodeRecord[]);
	expect(proposals).toHaveLength(1);
	expect(proposals[0]!.evidence).toHaveLength(5);
});
