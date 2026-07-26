import { expect, test } from "bun:test";
import { assessReversal, costEventsFrom, shouldDiscloseCost, summariseCost, type ReversalNode } from "../src/decision-impact.ts";

function node(address: string, over: Partial<ReversalNode> = {}): ReversalNode {
	return { id: address, address, title: `unit ${address}`, dependents: [], undoMinutes: 10, ...over };
}

test("reversal follows dependents — undoing 3.2 is not undoing 3.2 alone", () => {
	const nodes = [node("3.2", { dependents: ["3.3"] }), node("3.3", { dependents: ["3.4"] }), node("3.4"), node("9.9")];
	const r = assessReversal(nodes, "3.2");
	expect(r.touched.map((n) => n.address)).toEqual(["3.2", "3.3", "3.4"]);
	// Unrelated work is untouched — the blast radius is bounded, and saying so is the point.
	expect(r.touched.map((n) => n.address)).not.toContain("9.9");
	expect(r.totalUndoMinutes).toBe(30);
	expect(r.sentence).toContain("facing 2 other pieces of work");
	expect(r.sentence).toContain("All of it can be undone");
});

test("a leaf says nothing was built on it, rather than saying nothing at all", () => {
	expect(assessReversal([node("1")], "1").sentence).toContain("Nothing was built on it.");
});

test("an irreversible element is named with its nearest repair, never just 'impossible'", () => {
	const nodes = [
		node("3.2", { dependents: ["3.3"] }),
		node("3.3", { undoMinutes: undefined, irreversible: { what: "the published tag", nearestRepair: "a superseding release" } }),
	];
	const r = assessReversal(nodes, "3.2");
	expect(r.irreversible.map((n) => n.address)).toEqual(["3.3"]);
	expect(r.sentence).toContain("the published tag cannot be undone; the repair is a superseding release");
	// "Irreversible" alone tells a person nothing they can act on.
	expect(r.sentence).not.toMatch(/\bimpossible\b/);
});

test("work with no estimate is unknown, not free", () => {
	// Summing a missing estimate as zero understates exactly the work nobody has looked at closely.
	const r = assessReversal([node("1", { dependents: ["2"] }), node("2", { undoMinutes: undefined })], "1");
	expect(r.incomplete).toBe(true);
    expect(r.sentence).toContain("never been estimated — treat that as unknown, not as free");
	// And a fully-estimated graph does not carry the caveat.
	expect(assessReversal([node("1")], "1").sentence).toContain("About 10 minutes");
});

test("a dependency cycle still yields an answer rather than hanging", () => {
	// The graph is already wrong if it has one, but refusing to answer leaves a person with no estimate
	// at the moment they most need one.
	const nodes = [node("a", { dependents: ["b"] }), node("b", { dependents: ["a"] })];
	const r = assessReversal(nodes, "a");
	expect(r.touched.map((n) => n.address)).toEqual(["a", "b"]);
});

test("spend and waste are different facts, and waste carries its cause", () => {
	const s = summariseCost([
		{ cents: 1200 },
		{ cents: 800, wastedBecause: "an interruption arrived mid-run", idledAgents: 4, idledMinutes: 46 },
		{ cents: 300, wastedBecause: "an interruption arrived mid-run", idledAgents: 0, idledMinutes: 0 },
		{ cents: 100, wastedBecause: "a flaky test was retried" },
	]);
	expect(s.spentCents).toBe(2400);
	expect(s.wastedCents).toBe(1200);
	expect(s.byCause[0]!.cause).toBe("an interruption arrived mid-run");
	expect(s.byCause[0]!.cents).toBe(1100);
	expect(s.sentence).toContain("$24.00 spent, $12.00 of it wasted");
	// The idle cost of an interruption, stated in the terms a person feels it.
	expect(s.sentence).toContain("4 agents sat idle for 46 minutes");
});

test("unattributed waste is named as unattributed, not folded in silently", () => {
	// "$40 wasted" with nothing to point at makes a person feel bad and teaches them nothing.
	const s = summariseCost([{ cents: 500, wastedBecause: "   " }]);
	expect(s.byCause[0]!.cause).toBe("no cause was recorded");
	expect(s.sentence).toContain("no cause was recorded");
});

test("clean and empty spend are both said out loud", () => {
	expect(summariseCost([]).sentence).toBe("Nothing has been spent on this yet.");
	expect(summariseCost([{ cents: 900 }]).sentence).toBe("$9.00 spent, and none of it was wasted.");
});

test("cost is disclosed where it changes a decision, and hidden where it would be decoration", () => {
	// A ticker on every screen is how people learn to stop reading numbers — and then the one that
	// mattered goes past unread too.
	expect(shouldDiscloseCost({ changesTheDecision: true, cents: 1 })).toBe(true);
	expect(shouldDiscloseCost({ changesTheDecision: false, cents: 1 })).toBe(false);
	// Large enough is its own reason, whether or not there is a choice.
	expect(shouldDiscloseCost({ changesTheDecision: false, cents: 5_000 })).toBe(true);
	expect(shouldDiscloseCost({ changesTheDecision: false, cents: 4_999 })).toBe(false);
	expect(shouldDiscloseCost({ changesTheDecision: false, cents: 100, notableCents: 50 })).toBe(true);
});

test("cost comes from retained records, never from logs", () => {
	// Concern 17's point: by the time you reconstruct from logs the evidence is compacted, and what is
	// left is a plausible story rather than a record.
	const events = costEventsFrom([
		{ kind: "evidence", id: "e1", nodeId: "n1", createdAt: 1, claim: "cost:250", verification: "checked", sampleSize: 1, sourceNodeIds: [] },
		{ kind: "evidence", id: "e2", nodeId: "n1", createdAt: 1, claim: "Tests passed.", verification: "checked", sampleSize: 1, sourceNodeIds: [] },
	]);
	expect(events).toEqual([{ cents: 250 }]);
});

test("the manager answers the cost AND whether it should be shown", async () => {
	// The rule is enforced at the seam, not left to each render site. A rule every caller must
	// remember is one that someone will forget, and the failure is silent.
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const { SquadManager } = await import("../src/squad-manager.ts");
	const { FileStore } = await import("../src/dal/store.ts");
	const { NodeRecordStore } = await import("../src/node-records.ts");

	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "impact-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "impact-wt-"));
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();

	const store = new FileStore(stateDir);
	await store.putNode({ id: "n1", kind: "unit", title: "u", state: "working", createdAt: 1, channelId: null });
	await new NodeRecordStore(store).put({ kind: "evidence", id: "c1", nodeId: "n1", createdAt: 1, claim: "cost:120", verification: "checked", sampleSize: 1, sourceNodeIds: [] });

	const quiet = await mgr.costSummary("n1");
	expect(quiet.spentCents).toBe(120);
	// $1.20 beside no choice is decoration.
	expect(quiet.disclose).toBe(false);
	// The same number beside a choice it should influence is worth showing.
	expect((await mgr.costSummary("n1", { changesTheDecision: true })).disclose).toBe(true);

	// An unreadable store yields no cost rather than a wrong one, and never claims to disclose.
	const missing = await mgr.costSummary("does-not-exist");
	expect(missing.spentCents).toBe(0);
	expect(missing.sentence).toContain("Nothing has been spent");

	await mgr.stop();
	for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});

test("a rule reaches the point it acts with its author attached", async () => {
	// Concern 11 wants the sentence quotable verbatim; concern 19 wants the author to survive every
	// render path. A rule that becomes anonymous house policy on display has lost what made it
	// answerable — you cannot argue with a rule when you cannot see whose it is.
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const { SquadManager } = await import("../src/squad-manager.ts");
	const { FileStore } = await import("../src/dal/store.ts");
	const { NodeRecordStore } = await import("../src/node-records.ts");

	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "quote-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "quote-wt-"));
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();

	const store = new FileStore(stateDir);
	await store.putNode({ id: "n1", kind: "unit", title: "u", state: "working", createdAt: 1, channelId: null });
	const records = new NodeRecordStore(store);
	await records.put({ kind: "decision", id: "d1", nodeId: "n1", createdAt: 1, question: "q", options: [], chose: "yes", decidedBy: "db:lars", askedAt: 1, decidedAt: 2, reason: "no-rule-applied" });
	await records.put({
		kind: "rule", id: "r1", nodeId: "n1", createdAt: 3, authorId: "db:lars", scope: "org", status: "active",
		sentence: "If it can be undone in under a minute, just do it and tell me afterwards.",
		settles: ["reversible-change"], proposedFrom: ["d1"], wouldNotHaveCaught: [], invocations: [],
	});

	expect(await mgr.rulesQuotedFor("n1", "reversible-change")).toEqual([
		'"If it can be undone in under a minute, just do it and tell me afterwards." — db:lars',
	]);
	// An action no rule names quotes nothing, rather than quoting the nearest rule.
	expect(await mgr.rulesQuotedFor("n1", "publish-a-release")).toEqual([]);

	await mgr.stop();
	for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});
