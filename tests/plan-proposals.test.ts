import { expect, test } from "bun:test";
import { ReshapeError, consequenceSentence, readPlanProposal, reshape, startableNow, type PlanProposal, type ProposedUnit } from "../src/plan-proposals.ts";

function unit(address: string, over: Partial<ProposedUnit> = {}): ProposedUnit {
	return { address, title: `unit ${address}`, rationale: "it is a separable piece", after: [], touches: [], ...over };
}

function proposal(over: Partial<PlanProposal> = {}): PlanProposal {
	return {
		id: "p1",
		originalWords: "make the room stop burying my messages",
		authorId: "db:lars",
		createdAt: 1,
		repo: "/r",
		assumptions: [{ text: "you mean the #fleet room, not the per-unit threads", insteadOf: "you naming which room" }],
		units: [unit("1"), unit("2"), unit("3", { after: ["1"] })],
		status: "proposed",
		...over,
	};
}

test("the person's own sentence is kept verbatim, beside what was derived from it", () => {
	const p = proposal({ originalWords: "  make the room stop burying my messages  " });
	// Not trimmed, not normalised, not paraphrased. A person checks the derivation against what they
	// actually said, and any edit here makes that check impossible.
	expect(readPlanProposal(p)?.originalWords).toBe("  make the room stop burying my messages  ");
});

test("assumptions say what was assumed AND what would have settled it", () => {
	const p = readPlanProposal(proposal())!;
	expect(p.assumptions[0]!.text).toContain("#fleet room");
	// An assumption with no stated alternative is indistinguishable from a fact.
	expect(p.assumptions[0]!.insteadOf).toBeTruthy();
});

test("consequences, not counts", () => {
	const sentence = consequenceSentence(proposal({
		units: [unit("1", { touches: ["src/a.ts"] }), unit("2", { touches: ["src/b.ts"] }), unit("3", { after: ["1"], touches: ["src/a.ts"] })],
	}));
	expect(sentence).toContain("2 agents wake");
	expect(sentence).toContain("one more waits");
	expect(sentence).toContain("2 files are touched");
	expect(sentence).toContain("src/a.ts");
	// A count would be "3 tasks". None of these strings is a bare number of things.
	expect(sentence).not.toContain("3 tasks");
});

test("the consequence always states what will NOT happen", () => {
	// The blast-radius law. It survives every branch, including the all-parallel one.
	for (const units of [[unit("1")], [unit("1"), unit("2")], [unit("1"), unit("2", { after: ["1"] })]]) {
		expect(consequenceSentence(proposal({ units }))).toContain("Nothing lands without you.");
	}
});

test("unknown file impact is said out loud, not silently omitted", () => {
	// Absence-as-answer: no `touches` means nobody knows yet, which is NOT the same as "no files".
	const sentence = consequenceSentence(proposal({ units: [unit("1")] }));
	expect(sentence).toContain("not known yet");
	expect(sentence).not.toContain("0 files");
});

test("an ambiguous goal asks before spawning, and proposes nothing", () => {
	const p = proposal({ units: [], needsClarification: "Which room do you mean — #fleet, or the per-unit threads? They have opposite problems." });
	expect(p.units).toEqual([]);
	const sentence = consequenceSentence(p);
	expect(sentence).toContain("Nothing starts yet");
	expect(sentence).toContain("Which room do you mean");
	// It asks, and it does not also promise a plan it has not made.
	expect(sentence).not.toContain("agents wake");
});

test("startableNow is only what has no prerequisite", () => {
	expect(startableNow(proposal().units).map((u) => u.address)).toEqual(["1", "2"]);
});

// ── Reshaping: approve/reject is not review ────────────────────────────────────

test("a unit can be retitled, reordered and dropped", () => {
	const units = proposal().units;
	expect(reshape(units, { op: "retitle", address: "2", title: "better name" }).find((u) => u.address === "2")!.title).toBe("better name");
	expect(reshape(units, { op: "reorder", address: "2", after: ["1"] }).find((u) => u.address === "2")!.after).toEqual(["1"]);
	expect(reshape(units, { op: "drop", address: "2" }).map((u) => u.address)).toEqual(["1", "3"]);
});

test("dropping a unit something waits on is refused, not silently repaired", () => {
	// Silently rewiring the dependent would hand the person a plan they did not design.
	const err = (() => { try { reshape(proposal().units, { op: "drop", address: "1" }); } catch (e) { return e as Error; } })();
	expect(err).toBeInstanceOf(ReshapeError);
	expect(err!.message).toContain("cannot be dropped while 3 still wait");
	expect(err!.message).toContain("drop or reorder");
});

test("a reorder that would create a cycle is refused, and says what it would have caused", () => {
	const units = [unit("1", { after: ["2"] }), unit("2")];
	const err = (() => { try { reshape(units, { op: "reorder", address: "2", after: ["1"] }); } catch (e) { return e as Error; } })();
	expect(err).toBeInstanceOf(ReshapeError);
	expect(err!.message).toContain("nothing could start");
	// And a unit cannot wait on itself.
	expect(() => reshape(units, { op: "reorder", address: "2", after: ["2"] })).toThrow(/wait on itself/);
});

test("splitting a unit rewires everything that waited on it", () => {
	const units = proposal().units; // 3 waits on 1
	const after = reshape(units, { op: "split", address: "1", into: [{ title: "first half", rationale: "r" }, { title: "second half", rationale: "r" }] });
	expect(after.map((u) => u.address)).toEqual(["1.1", "1.2", "2", "3"]);
	// The parts run in order...
	expect(after.find((u) => u.address === "1.2")!.after).toEqual(["1.1"]);
	// ...and the old dependent now waits on the LAST part, not the first — waiting on the first would
	// let it start before the work it depends on had finished.
	expect(after.find((u) => u.address === "3")!.after).toEqual(["1.2"]);
	expect(() => reshape(units, { op: "split", address: "1", into: [{ title: "only", rationale: "r" }] })).toThrow(/at least two/);
});

test("merging two units keeps their combined prerequisites and drops the internal one", () => {
	const units = [unit("1"), unit("2", { after: ["1"] }), unit("3", { after: ["2"] })];
	const after = reshape(units, { op: "merge", addresses: ["2", "3"], title: "both halves", rationale: "they are one change" });
	expect(after.map((u) => u.address)).toEqual(["1", "2"]);
	// 3's dependency on 2 was internal to the merge and disappears; 2's dependency on 1 survives.
	expect(after.find((u) => u.address === "2")!.after).toEqual(["1"]);
	expect(after.find((u) => u.address === "2")!.title).toBe("both halves");
});

test("merging rewires outside dependents onto the merged unit", () => {
	const units = [unit("1"), unit("2"), unit("3", { after: ["2"] })];
	const after = reshape(units, { op: "merge", addresses: ["1", "2"], title: "one", rationale: "r" });
	expect(after.find((u) => u.address === "3")!.after).toEqual(["1"]);
});

test("reshaping a unit that does not exist is refused by name", () => {
	for (const op of [
		{ op: "drop" as const, address: "99" },
		{ op: "retitle" as const, address: "99", title: "x" },
		{ op: "reorder" as const, address: "99", after: [] },
		{ op: "split" as const, address: "99", into: [{ title: "a", rationale: "r" }, { title: "b", rationale: "r" }] },
		{ op: "merge" as const, addresses: ["1", "99"], title: "x", rationale: "r" },
	]) {
		expect(() => reshape(proposal().units, op)).toThrow(/no unit 99/);
	}
});

test("a proposed plan is not work — status distinguishes it from a started one", () => {
	// Concern 02's projection depends on this: a proposal must never be counted as in flight.
	expect(readPlanProposal(proposal())!.status).toBe("proposed");
	expect(readPlanProposal(proposal({ status: "started", startedAt: 5 }))!.startedAt).toBe(5);
	// A proposal with no status at all does not decode — it cannot default to "started".
	const { status: _status, ...noStatus } = proposal();
	expect(readPlanProposal(noStatus)).toBeUndefined();
});

test("a proposal that does not decode whole is dropped, never half-read", () => {
	const { originalWords: _w, ...noWords } = proposal();
	expect(readPlanProposal(noWords)).toBeUndefined();
	expect(readPlanProposal({ ...proposal(), units: [{ address: "1" }] })).toBeUndefined();
	expect(readPlanProposal(undefined)).toBeUndefined();
	// Round trip with every optional field set.
	const full = proposal({ needsClarification: "which room?", status: "started", startedAt: 9 });
	expect(readPlanProposal(full)).toEqual(full);
});

// --- Through the manager ---------------------------------------------------------------------

test("a proposal persists, reshapes, and starts as one deliberate act", async () => {
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const { SquadManager } = await import("../src/squad-manager.ts");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-wt-"));
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();

	const { consequence } = await mgr.proposePlan(proposal());
	expect(consequence).toContain("Nothing lands without you.");
	expect(await mgr.planProposals("proposed")).toHaveLength(1);
	// A proposal is NOT work in flight — concern 02's projection depends on this.
	expect(await mgr.planProposals("started")).toEqual([]);

	// The shape changes before it starts.
	const reshaped = await mgr.reshapeProposal("p1", { op: "retitle", address: "2", title: "renamed by a person" });
	expect(reshaped.proposal.units.find((u) => u.address === "2")!.title).toBe("renamed by a person");

	const started = await mgr.startProposal("p1", 500);
	expect(started.status).toBe("started");
	expect(started.startedAt).toBe(500);
	// Reshaping after the start is refused — at that point it is steering, not planning.
	await expect(mgr.reshapeProposal("p1", { op: "drop", address: "2" })).rejects.toThrow(/already started/);

	await mgr.stop();
	for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});

test("an ambiguous proposal cannot be started, and cannot smuggle units past the question", async () => {
	const fs = await import("node:fs/promises");
	const os = await import("node:os");
	const path = await import("node:path");
	const { SquadManager } = await import("../src/squad-manager.ts");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-ambig-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-ambig-wt-"));
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();

	// Asking and proposing at once means the units rest on a guess the planner itself flagged.
	await expect(mgr.proposePlan(proposal({ id: "bad", needsClarification: "which room?" }))).rejects.toThrow(/proposes no units/);
	// An empty sentence has nothing to derive from.
	await expect(mgr.proposePlan(proposal({ id: "empty", originalWords: "   " }))).rejects.toThrow(/own words/);

	await mgr.proposePlan(proposal({ id: "ask", units: [], needsClarification: "Which room do you mean?" }));
	await expect(mgr.startProposal("ask")).rejects.toThrow(/still waiting on an answer/);
	await expect(mgr.startProposal("nope")).rejects.toThrow(/no proposal nope/);

	await mgr.stop();
	for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});
