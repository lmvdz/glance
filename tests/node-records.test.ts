import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { NodeRecordStore, nodeRecordKinds, readNodeRecord, type NodeRecord } from "../src/node-records.ts";
import type { Node } from "../src/nodes.ts";

async function store(opts: { seedEvidence?: boolean } = {}): Promise<{ store: FileStore; records: NodeRecordStore; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "node-records-"));
	const fileStore = new FileStore(dir);
	const node: Node = { id: "n1", kind: "unit", title: "the unit", state: "working", createdAt: 1, channelId: null };
	await fileStore.putNode(node);
	const records = new NodeRecordStore(fileStore);
	// A rule may only cite decisions that exist, so any test that writes one needs its evidence present.
	// Seeded with the SAME id the rule sample cites, so the round-trip test's own decision write lands
	// on this row rather than adding one — the record count still equals the number of kinds.
	if (opts.seedEvidence !== false) await records.put(samples.decision);
	return { store: fileStore, records, dir };
}

/**
 * One fully-populated example of every record kind, with EVERY optional field set. The point is the
 * round trip below: the shape that shipped first declared these fields in a TypeScript interface and
 * hand-wrote a reader beside it, so a field the reader forgot vanished on read with no error. A
 * withdrawn rule came back withdrawn but with no withdrawal time and no pointer to its replacement.
 */
const samples: Record<(typeof nodeRecordKinds)[number], NodeRecord> = {
	rule: {
		kind: "rule",
		id: "r1",
		nodeId: "n1",
		createdAt: 10,
		sentence: "If it can be undone in under a minute, just do it and tell me afterwards.",
		authorId: "db:lars",
		scope: "org",
		settles: ["reversible-change"],
		status: "withdrawn",
		withdrawnAt: 99,
		withdrawnBy: "db:lars",
		replacedById: "r2",
		proposedFrom: ["decision-41"],
		wouldNotHaveCaught: ["the credential rotation on the 14th — that stays yours"],
		invocations: [{ at: 11, outcome: "settled", nodeId: "n1" }, { at: 12, outcome: "outside-clear-reach", nodeId: "n1" }],
	},
	"delegation-boundary": {
		kind: "delegation-boundary",
		id: "b1",
		nodeId: "n1",
		createdAt: 10,
		class: "credentials",
		justification: "A credential you did not hand over cannot be one you agreed to spend.",
	},
	"instruction-readback": {
		kind: "instruction-readback",
		id: "i1",
		nodeId: "n1",
		createdAt: 10,
		instruction: "Tidy the retry logic and cut a release.",
		authorId: "db:lars",
		agentId: "wren",
		reversible: [{ element: "tidy the retry logic", reading: "refactor without changing the backoff curve", correctionCost: "eleven minutes to re-run the suite" }],
		irreversible: [{ element: "cut a release", reading: "publish a tag to the registry", nearestRepair: "a superseding release; the tag itself cannot be unpublished" }],
		ambiguous: ["'tidy' does not say whether the jitter is in scope"],
		irreversibleStatus: "pending",
	},
	objection: {
		kind: "objection",
		id: "o1",
		nodeId: "n1",
		createdAt: 10,
		instructionId: "i1",
		agentId: "wren",
		prediction: "The suite will fail on retry-budget.test.ts within two minutes of this change.",
		overruledBy: "db:lars",
		status: "outcome-recorded",
		outcome: "It failed at 94 seconds, on that file.",
		outcomeMatchedPrediction: true,
		outcomeRecordedAt: 120,
	},
	"plan-motion": {
		kind: "plan-motion",
		id: "m1",
		nodeId: "n1",
		createdAt: 10,
		lastMeaningfulMovementAt: 5,
		baselineMs: 34 * 60 * 1000,
		baselineSampleSize: 11,
		parked: false,
		intentionalStill: false,
		blockedCause: "waiting on a review nobody was asked for",
		eligibleSuccessorCount: 3,
		noticedAt: 70,
		outcome: "acknowledged",
	},
	evidence: {
		kind: "evidence",
		id: "e1",
		nodeId: "n1",
		createdAt: 10,
		claim: "Wren has landed every migration she has opened.",
		verification: "checked",
		sampleSize: 34,
		sourceNodeIds: ["n1"],
		checkedAt: 20,
		staleAt: 999,
		withdrawnAt: 1000,
	},
	decision: {
		kind: "decision",
		id: "decision-41",
		nodeId: "n1",
		createdAt: 10,
		question: "Take the reversible option?",
		options: ["yes", "no"],
		chose: "yes",
		decidedBy: "db:lars",
		askedAt: 5,
		decidedAt: 65_000,
		reason: "no-rule-applied",
		boundaryClass: "publishing",
	},
	"human-authority": { kind: "human-authority", id: "h1", nodeId: "n1", createdAt: 10, humanId: "db:lars", role: "accountable" },
	handover: {
		kind: "handover",
		id: "v1",
		nodeId: "n1",
		createdAt: 10,
		fromActorId: "wren",
		toActorId: "pike",
		carried: ["the branch", "the test results"],
		notCarried: ["Wren's reasoning about the backoff curve"],
		staleEvidenceIds: ["e1"],
		reverifyAgainstRef: "origin/main",
	},
	retention: {
		kind: "retention",
		id: "t1",
		nodeId: "n1",
		createdAt: 10,
		authorizedBy: "db:lars",
		compactedAt: 50,
		cut: ["407 tool-approval prompts"],
		preserved: ["the decision to ship", "the evidence known at the time", "every human sentence"],
		fidelity: "compacted",
	},
	summary: {
		kind: "summary",
		id: "summary:n1:upward",
		nodeId: "n1",
		createdAt: 10,
		direction: "upward",
		markdown: "Current state: input.",
		sources: ["record:decision-41", "plan:plans/room-threads/06-node-summaries.md"],
	},
};

test("every record kind survives a round trip with every optional field intact", async () => {
	const { store: fileStore, records, dir } = await store();
	for (const kind of nodeRecordKinds) await records.put(samples[kind]);

	const read = await fileStore.listNodeRecords("n1");
	expect(read).toHaveLength(nodeRecordKinds.length);
	for (const kind of nodeRecordKinds) {
		const back = read.find((record) => record.kind === kind);
		// toEqual, not toMatchObject: a field dropped on read must fail here, which is exactly what the
		// hand-written reader let through.
		expect(back).toEqual(samples[kind]);
	}
	await fs.rm(dir, { recursive: true, force: true });
});

test("a withdrawn rule keeps when it was withdrawn, by whom, and what replaced it", async () => {
	const { store: fileStore, records, dir } = await store();
	await records.put(samples.rule);
	const back = (await fileStore.listNodeRecords("n1")).find((record) => record.kind === "rule");
	expect(back?.kind).toBe("rule");
	if (back?.kind !== "rule") throw new Error("expected a rule");
	expect(back.withdrawnAt).toBe(99);
	expect(back.withdrawnBy).toBe("db:lars");
	expect(back.replacedById).toBe("r2");
	// The human's sentence is stored verbatim so it can be quoted where it acted.
	expect(back.sentence).toBe("If it can be undone in under a minute, just do it and tell me afterwards.");
	await fs.rm(dir, { recursive: true, force: true });
});

test("a rule settles only the actions it names, and never a non-delegatable class", async () => {
	const { records, dir } = await store();
	await records.put({ ...samples.rule, id: "r-active", status: "active", withdrawnAt: undefined, withdrawnBy: undefined, replacedById: undefined });

	expect(await records.mayRuleSettle("n1", "reversible-change")).toBe(true);
	// The defect this pins: an earlier version returned true whenever ANY active rule existed on the
	// node, so one rule about reversible changes silently authorised everything else on it too.
	expect(await records.mayRuleSettle("n1", "publish-a-release")).toBe(false);
	expect(await records.mayRuleSettle("n1", "")).toBe(false);
	// And no rule reaches the immutable class, even when it names the action outright.
	await records.put({ ...samples.rule, id: "r-overreach", status: "active", settles: ["rotate-credentials"], withdrawnAt: undefined, withdrawnBy: undefined, replacedById: undefined });
	expect(await records.mayRuleSettle("n1", "rotate-credentials", "credentials")).toBe(false);
	expect(await records.mayRuleSettle("n1", "rotate-credentials", "spend")).toBe(false);
	await fs.rm(dir, { recursive: true, force: true });
});

test("a node with no rules settles nothing — absence is never permission", async () => {
	const { records, dir } = await store();
	expect(await records.mayRuleSettle("n1", "reversible-change")).toBe(false);
	expect(await records.rulesSettling("n1", "reversible-change")).toEqual([]);
	// A withdrawn rule is not a rule.
	await records.put(samples.rule);
	expect(await records.mayRuleSettle("n1", "reversible-change")).toBe(false);
	await fs.rm(dir, { recursive: true, force: true });
});

test("the rules that settled an action are retrievable so each can be quoted verbatim", async () => {
	const { records, dir } = await store();
	await records.put({ ...samples.rule, id: "r-a", status: "active", withdrawnAt: undefined, withdrawnBy: undefined, replacedById: undefined });
	await records.put({ ...samples.rule, id: "r-b", status: "active", sentence: "Never wake me for a test flake.", settles: ["reversible-change"], withdrawnAt: undefined, withdrawnBy: undefined, replacedById: undefined });
	const settling = await records.rulesSettling("n1", "reversible-change");
	expect(settling.map((rule) => rule.sentence).sort()).toEqual([
		"If it can be undone in under a minute, just do it and tell me afterwards.",
		"Never wake me for a test flake.",
	]);
	await fs.rm(dir, { recursive: true, force: true });
});

test("an objection without a falsifiable prediction is refused at creation", async () => {
	const { records, dir } = await store();
	await expect(records.put({ ...samples.objection, prediction: "   " })).rejects.toThrow(/falsifiable prediction/);
	await expect(records.put({ ...samples.objection, prediction: "" })).rejects.toThrow(/falsifiable prediction/);
	await fs.rm(dir, { recursive: true, force: true });
});

test("an evidence claim with no sample is refused — a claim with no sample is not a claim", async () => {
	const { records, dir } = await store();
	await expect(records.put({ ...samples.evidence, sampleSize: 0 })).rejects.toThrow(/sample size/);
	await expect(records.put({ ...samples.evidence, sampleSize: 1.5 })).rejects.toThrow(/sample size/);
	await fs.rm(dir, { recursive: true, force: true });
});

test("a record for an absent node is refused rather than orphaned", async () => {
	const { records, dir } = await store();
	await expect(records.put({ ...samples.rule, nodeId: "does-not-exist" })).rejects.toThrow(/node not found/);
	await expect(records.put({ ...samples.rule, id: "  " })).rejects.toThrow(/required/);
	await fs.rm(dir, { recursive: true, force: true });
});

test("a half-written record is dropped whole, never half-read", () => {
	// Missing `settles` entirely: the record does not decode, so it does not come back as a rule with
	// an empty settles list — which would read as "settles nothing" and be indistinguishable from a
	// deliberate one.
	const { settles: _settles, ...withoutSettles } = samples.rule as Extract<NodeRecord, { kind: "rule" }>;
	expect(readNodeRecord(withoutSettles)).toBeUndefined();
	expect(readNodeRecord({ kind: "rule" })).toBeUndefined();
	expect(readNodeRecord({ kind: "not-a-kind", id: "x", nodeId: "n1", createdAt: 1 })).toBeUndefined();
	expect(readNodeRecord(undefined)).toBeUndefined();
	expect(readNodeRecord(samples.rule)).toEqual(samples.rule);
});

test("records are listed in creation order and scoped to their own node", async () => {
	const { store: fileStore, records, dir } = await store({ seedEvidence: false });
	await fileStore.putNode({ id: "n2", kind: "unit", title: "another", state: "idle", createdAt: 1, channelId: null });
	await records.put({ ...samples.evidence, id: "e-late", createdAt: 300 });
	await records.put({ ...samples.evidence, id: "e-early", createdAt: 100 });
	await records.put({ ...samples.evidence, id: "e-other", nodeId: "n2", createdAt: 200 });

	expect((await records.list("n1")).map((record) => record.id)).toEqual(["e-early", "e-late"]);
	expect((await records.list("n2")).map((record) => record.id)).toEqual(["e-other"]);
	await fs.rm(dir, { recursive: true, force: true });
});

test("a record that could not be read back is refused at write, never silently lost", async () => {
	// The defect this pins, which shipped in the first version of this store: `put` validated a handful
	// of fields and the reader decoded the whole schema. A record missing a required field was WRITTEN
	// successfully and then vanished on read — no error at the write, no error at the read, no record.
	// A write that reports success and produces nothing is the worst shape absence-as-answer can take.
	const { records, dir } = await store();
	const { reason: _reason, ...noReason } = samples.decision as Extract<NodeRecord, { kind: "decision" }>;
	await expect(records.put(noReason as NodeRecord)).rejects.toThrow(/cannot be read back/);

	const { verification: _v, ...noVerification } = samples.evidence as Extract<NodeRecord, { kind: "evidence" }>;
	await expect(records.put(noVerification as NodeRecord)).rejects.toThrow(/cannot be read back/);

	// Nothing was persisted by either refusal.
	expect((await records.list("n1")).map((record) => record.id)).toEqual(["decision-41"]);
	await fs.rm(dir, { recursive: true, force: true });
});
