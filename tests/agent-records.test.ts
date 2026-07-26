import { expect, test } from "bun:test";
import { agentRecordView } from "../src/agent-records.ts";
import type { NodeRecord } from "../src/node-records.ts";

const profile: NodeRecord = {
	kind: "agent-profile", id: "profile:wren", nodeId: "wren", agentId: "wren", createdAt: 10,
	roleDefault: "migration verifier", status: "provisional", checking: { requiredUnits: 10, checkedUnits: 3, reviewerId: "pike" },
};
const evidence = (id: string, extra: Partial<Extract<NodeRecord, { kind: "evidence" }>> = {}): NodeRecord => ({
	kind: "evidence", id, nodeId: "wren", createdAt: 20, claim: "Three migrations were independently verified.",
	verification: "checked", sampleSize: 3, sourceNodeIds: ["unit-1", "unit-2", "unit-3"], checkedAt: 20, ...extra,
});

test("one agent record keeps defaults distinct from evidence and opens every claim to its units", () => {
	const record = agentRecordView("wren", [profile, evidence("e1")], 30);
	expect(record).toEqual({
		agentId: "wren", roleDefault: "migration verifier", provisional: true,
		checking: { requiredUnits: 10, checkedUnits: 3, reviewerId: "pike" }, profileMissing: false,
		claims: [{ id: "e1", claim: "Three migrations were independently verified.", verification: "checked", sampleSize: 3, date: 20, state: "current", sourceNodeIds: ["unit-1", "unit-2", "unit-3"] }],
	});
});

test("past-freshness and withdrawn claims remain visible with their honest state", () => {
	const record = agentRecordView("wren", [profile, evidence("stale", { staleAt: 30 }), evidence("withdrawn", { withdrawnAt: 30 })], 30);
	expect(record.claims.map((claim) => [claim.id, claim.state])).toEqual([["stale", "stale"], ["withdrawn", "withdrawn"]]);
});

test("missing profile stays unknown rather than manufacturing an established record", () => {
	const record = agentRecordView("new-agent", [], 30);
	expect(record).toEqual({ agentId: "new-agent", roleDefault: undefined, provisional: false, checking: undefined, profileMissing: true, claims: [] });
});

test("there is no cross-agent aggregate: evidence from another node is not accepted by this record", () => {
	const foreign = { ...evidence("foreign"), nodeId: "other-agent" } as NodeRecord;
	expect(agentRecordView("wren", [profile, foreign], 30).claims).toEqual([]);
});
