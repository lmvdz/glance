import { expect, test } from "bun:test";
import { compactableKinds, compactionNotice, evidenceAge, liveKinds, planCompaction, planHandover, preservedKinds } from "../src/archive.ts";
import { NodeRecordStore, nodeRecordKinds, type NodeRecord } from "../src/node-records.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { DelegationBoundaryError } from "../src/delegation-boundary.ts";
import { SquadManager } from "../src/squad-manager.ts";

const T = 1_000_000_000;
const OLD = T - 10 * 24 * 60 * 60 * 1000;

function rec(kind: NodeRecord["kind"], id: string, createdAt: number): NodeRecord {
	const base = { id, nodeId: "n1", createdAt };
	switch (kind) {
		case "decision":
			return { ...base, kind, question: "Take the reversible option?", options: ["yes", "no"], chose: "yes", decidedBy: "db:lars", askedAt: createdAt, decidedAt: createdAt, reason: "no-rule-applied" };
		case "rule":
			return { ...base, kind, sentence: "Just do it and tell me afterwards.", authorId: "db:lars", scope: "org", settles: ["reversible-change"], status: "active", proposedFrom: ["d1"], wouldNotHaveCaught: [], invocations: [] };
		case "objection":
			return { ...base, kind, instructionId: "i1", agentId: "wren", prediction: "The suite will fail.", status: "raised" };
		case "instruction-readback":
			return { ...base, kind, instruction: "Ship it.", authorId: "db:lars", agentId: "wren", reversible: [], irreversible: [], ambiguous: [], irreversibleStatus: "pending" };
		case "human-authority":
			return { ...base, kind, humanId: "db:lars", role: "accountable" };
		case "delegation-boundary":
			return { ...base, kind, class: "credentials", justification: "A credential you did not hand over is not one you agreed to spend." };
		case "evidence":
			return { ...base, kind, claim: "Tests passed.", verification: "checked", sampleSize: 3, sourceNodeIds: ["n1"], checkedAt: createdAt };
		case "agent-profile":
			return { ...base, kind, agentId: "n1", roleDefault: "general coding", status: "provisional", checking: { requiredUnits: 10, checkedUnits: 0 } };
		case "plan-motion":
			return { ...base, kind, lastMeaningfulMovementAt: createdAt, baselineSampleSize: 4, parked: false, intentionalStill: false, eligibleSuccessorCount: 1 };
		case "handover":
			return { ...base, kind, fromActorId: "wren", toActorId: "pike", carried: [], notCarried: [], staleEvidenceIds: [] };
		case "retention":
			return { ...base, kind, authorizedBy: "db:lars", compactedAt: createdAt, cut: [], preserved: [], fidelity: "full" };
		case "summary":
			return { ...base, kind, direction: "upward", markdown: "Current state: working.", sources: [] };
		case "learning-state":
			return { ...base, kind, borrowedDefaults: [{ id: "merge", sentence: "Nobody merges to main without you.", reversal: "Withdraw this default in one action.", status: "borrowed" }], outOfHoursContact: "unset", unknowns: [{ id: "decisions", statement: "Which decisions you care about.", settlingEvidence: "Five identical answers.", requiredSampleSize: 5, costOfNotKnowing: "The fleet keeps asking.", proposalSubjects: ["*"] }] };
	}
}

const policy = { authorizedBy: "db:lars", olderThanMs: 24 * 60 * 60 * 1000, reason: "Tool chatter past a day is not worth the disk." };

test("every record kind is explicitly archival or live state — none is unconsidered", () => {
	// The classification is only a boundary if nothing can be added beside it without a decision.
	const classified = new Set<string>([...preservedKinds, ...compactableKinds, ...liveKinds]);
	expect(nodeRecordKinds.filter((kind) => !classified.has(kind))).toEqual([]);
	// No kind is both archival classes, and live state cannot quietly enter either archive lane.
	expect(preservedKinds.filter((kind) => (compactableKinds as readonly string[]).includes(kind))).toEqual([]);
	expect(liveKinds.filter((kind) => ([...preservedKinds, ...compactableKinds] as readonly string[]).includes(kind))).toEqual([]);
});

test("decisions, rules, readings, objections and authority are never cut — at any age, under any policy", () => {
	const ancient = preservedKinds.map((kind, n) => rec(kind, `p${n}`, 0));
	const plan = planCompaction(ancient, { ...policy, olderThanMs: 1 }, T);
	expect(plan.cut).toEqual([]);
	expect(plan.kept.every(({ because }) => because === "preserved-kind")).toBe(true);
	expect(plan.retention.fidelity).toBe("full");
});

test("a live summary is neither archived nor compacted", () => {
	const plan = planCompaction([rec("summary", "summary:n1:upward", OLD)], policy, T);
	expect(plan.cut).toEqual([]);
	expect(plan.kept).toEqual([]);
	expect(plan.retention.fidelity).toBe("full");
});

test("a compaction declares what it cut, what it kept, when, and who authorized it", () => {
	const records = [rec("decision", "d1", OLD), rec("evidence", "e1", OLD), rec("plan-motion", "m1", OLD)];
	const plan = planCompaction(records, policy, T);
	expect(plan.cut.map((r) => r.id).sort()).toEqual(["e1", "m1"]);
	expect(plan.kept.map(({ record }) => record.id)).toEqual(["d1"]);
	expect(plan.retention.authorizedBy).toBe("db:lars");
	expect(plan.retention.compactedAt).toBe(T);
	expect(plan.retention.fidelity).toBe("compacted");
	// The cut is legible AFTER the records are gone — that is the whole point of keeping descriptions.
	expect(plan.retention.cut.join(" ")).toContain("Tests passed.");
	expect(plan.retention.preserved.join(" ")).toContain("Take the reversible option?");
});

test("planning does not cut anything — the consequence is shown before it happens", () => {
	const records = [rec("evidence", "e1", OLD)];
	const plan = planCompaction(records, policy, T);
	expect(plan.cut).toHaveLength(1);
	// The input is untouched; applying is a separate act a human authorizes.
	expect(records).toHaveLength(1);
	expect(records[0]!.id).toBe("e1");
});

test("recent records survive even when their kind allows compaction", () => {
	const plan = planCompaction([rec("evidence", "fresh", T - 1000)], policy, T);
	expect(plan.cut).toEqual([]);
	expect(plan.kept[0]!.because).toBe("too-recent");
});

test("a compacted record announces itself as incomplete at every read", () => {
	const compacted = planCompaction([rec("decision", "d1", OLD), rec("evidence", "e1", OLD)], policy, T).retention;
	const notice = compactionNotice({ ...compacted, id: "t1", nodeId: "n1" });
	// A summary that can be mistaken for the record is the failure this concern exists to prevent.
	expect(notice).toContain("This is not the full record");
	expect(notice).toContain("db:lars");
	expect(notice).toContain("every decision, every rule, and everything a person wrote");

	// And when nothing was cut, it says THAT rather than staying silent — silence reads as loss.
	const full = planCompaction([rec("decision", "d1", OLD)], policy, T).retention;
	expect(compactionNotice({ ...full, id: "t2", nodeId: "n1" })).toContain("Nothing was cut here");
});

test("evidence age is an instruction, not a label", () => {
	const fresh = evidenceAge(T - 60_000, T);
	expect(fresh.stale).toBe(false);
	expect(fresh.sentence).toContain("1 minute old");

	const stale = evidenceAge(T - 34 * 60_000, T);
	expect(stale.stale).toBe(true);
	// The design's own example: it tells you what to do, it does not merely say "stale".
	expect(stale.sentence).toContain("34 minutes old");
	expect(stale.sentence).toContain("re-run them against today's main");

	expect(evidenceAge(T - 3 * 60 * 60_000, T).sentence).toContain("3 hours old");
});

test("never checked is not the same as checked long ago, and never reads as fresh", () => {
	// The absence case. Unverified evidence with no timestamp must not fall through as current.
	const never = evidenceAge(undefined, T);
	expect(never.stale).toBe(true);
	expect(never.sentence).toContain("never verified");
	expect(never.sentence).not.toContain("minutes old");
});

test("a handover names what does NOT come across, before it is confirmed", () => {
	const records = [
		rec("decision", "d1", T - 1000),
		rec("rule", "r1", T - 1000),
		rec("plan-motion", "m1", T - 1000),
		rec("retention", "t1", T - 1000),
	];
	const plan = planHandover(records, { from: "Wren", to: "Pike", now: T });
	expect(plan.carried).toHaveLength(2);
	expect(plan.notCarried).toHaveLength(2);
	// A human cannot consent to an unnamed omission.
	expect(plan.sentence).toContain("do not come across");
	expect(plan.sentence).toContain("Pike picks this up from Wren");
	expect(plan.sentence).toContain("still attributed to whoever made it");
});

test("stale evidence is marked stale at the point of transfer, not silently carried", () => {
	const records = [
		{ ...rec("evidence", "old", T - 60 * 60_000), checkedAt: T - 60 * 60_000 } as NodeRecord,
		{ ...rec("evidence", "new", T - 60_000), checkedAt: T - 60_000 } as NodeRecord,
	];
	const plan = planHandover(records, { from: "Wren", to: "Pike", now: T, ref: "origin/main" });
	expect(plan.staleEvidenceIds).toEqual(["old"]);
	expect(plan.sentence).toContain("marked stale");
	expect(plan.sentence).toContain("origin/main");

	// And when nothing is stale it says so, rather than leaving the reader to infer it from silence.
	const clean = planHandover([records[1]!], { from: "Wren", to: "Pike", now: T });
	expect(clean.staleEvidenceIds).toEqual([]);
	expect(clean.sentence).toContain("Nothing carried across is stale");
});

test("evidence with no checkedAt is stale at transfer too", () => {
	const noTimestamp = { ...rec("evidence", "unchecked", T - 1000), checkedAt: undefined } as NodeRecord;
	expect(planHandover([noTimestamp], { from: "a", to: "b", now: T }).staleEvidenceIds).toEqual(["unchecked"]);
});

test("the freshness window is a stated default, not a hidden constant", () => {
	// 30 minutes by default: 29 is fresh, 31 is not.
	expect(evidenceAge(T - 29 * 60_000, T).stale).toBe(false);
	expect(evidenceAge(T - 31 * 60_000, T).stale).toBe(true);
	// Callers can tighten it; the sentence follows the window they chose.
	expect(evidenceAge(T - 5 * 60_000, T, { freshnessMs: 60_000 }).stale).toBe(true);
	expect(evidenceAge(T - 5 * 60_000, T, { freshnessMs: 60 * 60_000 }).stale).toBe(false);
});

// --- Through the manager, where compaction is deletion --------------------------------------------

async function mgr(): Promise<{ manager: SquadManager; nodeId: string; stateDir: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-mgr-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "archive-wt-"));
	const manager = new SquadManager({ stateDir, worktreeBase });
	await manager.start();
	const store = new FileStore(stateDir);
	await store.putNode({ id: "n1", kind: "unit", title: "unit", state: "working", createdAt: 1, channelId: null });
	const records = new NodeRecordStore(store);
	for (const record of [rec("decision", "d1", OLD), rec("evidence", "e1", OLD), rec("plan-motion", "m1", OLD)]) {
		await records.put(record);
	}
	return { manager, nodeId: "n1", stateDir };
}

test("compaction is deletion, so an autonomous one is refused without a grant", async () => {
	const { manager, nodeId, stateDir } = await mgr();
	// Whatever it is called, it removes records. Concern 12's boundary reaches it.
	await expect(manager.applyCompaction(nodeId, policy)).rejects.toThrow(DelegationBoundaryError);
	// Nothing was removed by the refusal.
	expect(await new NodeRecordStore(new FileStore(stateDir)).list(nodeId)).toHaveLength(3);

	// A person compacting is never blocked by this boundary.
	const { plan, removed, notice } = await manager.applyCompaction(nodeId, policy, { authority: "human" });
	expect(plan.cut.map((r) => r.id).sort()).toEqual(["e1", "m1"]);
	expect(removed).toBe(2);
	expect(notice).toContain("This is not the full record");

	const after = await new NodeRecordStore(new FileStore(stateDir)).list(nodeId);
	// The decision survived, and a retention record now declares the cut.
	expect(after.filter((r) => r.kind === "decision")).toHaveLength(1);
	expect(after.filter((r) => r.kind === "retention")).toHaveLength(1);
	expect(after.find((r) => r.id === "e1")).toBeUndefined();
	await manager.stop();
	await fs.rm(stateDir, { recursive: true, force: true });
});

test("the retention record is written BEFORE anything is removed", async () => {
	// A crash between the two must leave a declared cut with the data still present — the recoverable
	// direction. The opposite order loses records with nothing saying they existed.
	const { manager, nodeId, stateDir } = await mgr();
	const store = new FileStore(stateDir);
	const seen: string[] = [];
	const realDelete = store.deleteNodeRecords.bind(store);
	const spy = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
		async putNodeRecord(record: NodeRecord) { seen.push(`put:${record.kind}`); return FileStore.prototype.putNodeRecord.call(store, record); },
		async deleteNodeRecords(node: string, ids: readonly string[]) { seen.push("delete"); return realDelete(node, ids); },
	});
	const m2 = new SquadManager({ stateDir, worktreeBase: await fs.mkdtemp(path.join(os.tmpdir(), "archive-order-")), store: spy });
	await m2.start();
	await m2.applyCompaction(nodeId, policy, { authority: "human" });
	expect(seen).toEqual(["put:retention", "delete"]);
	await m2.stop();
	await manager.stop();
	await fs.rm(stateDir, { recursive: true, force: true });
});

test("a handover plan reaches the manager with its omissions and staleness named", async () => {
	const { manager, nodeId, stateDir } = await mgr();
	const plan = await manager.planHandover(nodeId, "Wren", "Pike", { now: T, ref: "origin/main" });
	expect(plan.sentence).toContain("Pike picks this up from Wren");
	expect(plan.notCarried.length).toBeGreaterThan(0);
	// e1 was checked ten days ago.
	expect(plan.staleEvidenceIds).toEqual(["e1"]);
	expect(plan.sentence).toContain("origin/main");
	await manager.stop();
	await fs.rm(stateDir, { recursive: true, force: true });
});
