import { expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { castPlanVote, closePlanVoteRound, currentPlanVoteRound, listPlanVoteRounds, openPlanVoteRound, planVoteGateOpen, planVotesPath, tallyPlanVoteRound } from "../src/plan-votes.ts";
import type { ArtifactComment } from "../src/comments.ts";

async function tmp(): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), "plan-votes-"));
}

test("open → fold returns a voting round with the snapshotted roster and no casts", async () => {
	const dir = await tmp();
	try {
		const round = await openPlanVoteRound(dir, {
			featureId: "feat",
			repo: "/r",
			planPath: "plans/x/01.md",
			candidateId: "c1",
			baseSha: "abc123",
			revisionSha: "def456",
			assignees: ["a1", "a2", "a1"], // dedupe
			openedBy: "a1",
		});
		expect(round.state).toBe("voting");
		expect(round.assignees).toEqual(["a1", "a2"]);
		expect(round.casts).toEqual([]);

		const [got] = await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat" });
		expect(got?.id).toBe(round.id);
		expect(got?.baseSha).toBe("abc123");
		expect(got?.revisionSha).toBe("def456");
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("cast folds onto the round; recasting the same actor overwrites (last write wins, no double-vote)", async () => {
	const dir = await tmp();
	try {
		const round = await openPlanVoteRound(dir, { featureId: "feat", repo: "/r", planPath: "p.md", candidateId: "c1", baseSha: "", revisionSha: "", assignees: ["a1", "a2"], openedBy: "a1" });
		await castPlanVote(dir, round.id, "a1", "approve", 1);
		await castPlanVote(dir, round.id, "a1", "reject", 2); // flips their own vote

		const [got] = await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat" });
		expect(got?.casts).toHaveLength(1);
		expect(got?.casts[0]).toEqual({ actorId: "a1", choice: "reject", at: 2 });
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("close sets terminal state; a second close is ignored (first close wins, idempotent)", async () => {
	const dir = await tmp();
	try {
		const round = await openPlanVoteRound(dir, { featureId: "feat", repo: "/r", planPath: "p.md", candidateId: "c1", baseSha: "", revisionSha: "", assignees: ["a1"], openedBy: "a1" });
		await closePlanVoteRound(dir, round.id, "passed", "sole assignee auto-pass (1 > 0.5)", 10);
		await closePlanVoteRound(dir, round.id, "rejected", "should be ignored", 20); // race — must not overwrite

		const [got] = await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat" });
		expect(got?.state).toBe("passed");
		expect(got?.closedAt).toBe(10);
		expect(got?.closedReason).toBe("sole assignee auto-pass (1 > 0.5)");
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("currentPlanVoteRound finds the one open round; none once closed", async () => {
	const dir = await tmp();
	try {
		expect(await currentPlanVoteRound(dir, "/r", "feat")).toBeUndefined();
		const round = await openPlanVoteRound(dir, { featureId: "feat", repo: "/r", planPath: "p.md", candidateId: "c1", baseSha: "", revisionSha: "", assignees: ["a1"], openedBy: "a1" });
		expect((await currentPlanVoteRound(dir, "/r", "feat"))?.id).toBe(round.id);
		await closePlanVoteRound(dir, round.id, "rejected");
		expect(await currentPlanVoteRound(dir, "/r", "feat")).toBeUndefined();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("filters by repo + featureId, same discipline as comments.ts", async () => {
	const dir = await tmp();
	try {
		await openPlanVoteRound(dir, { featureId: "feat1", repo: "/r", planPath: "p.md", candidateId: "c1", baseSha: "", revisionSha: "", assignees: ["a1"], openedBy: "a1" });
		await openPlanVoteRound(dir, { featureId: "feat2", repo: "/r", planPath: "p.md", candidateId: "c2", baseSha: "", revisionSha: "", assignees: ["a1"], openedBy: "a1" });
		await openPlanVoteRound(dir, { featureId: "feat1", repo: "/other", planPath: "p.md", candidateId: "c3", baseSha: "", revisionSha: "", assignees: ["a1"], openedBy: "a1" });
		const got = await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat1" });
		expect(got.map((r) => r.candidateId)).toEqual(["c1"]);
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("a torn trailing line is skipped, not thrown", async () => {
	const dir = await tmp();
	try {
		await openPlanVoteRound(dir, { id: "pvX", featureId: "feat", repo: "/r", planPath: "p.md", candidateId: "c1", baseSha: "", revisionSha: "", assignees: ["a1"], openedBy: "a1" });
		await fsp.appendFile(planVotesPath(dir), '{"type":"cast","roundId":"pvX"'); // truncated
		const got = await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat" });
		expect(got).toHaveLength(1);
		expect(got[0]?.casts).toEqual([]);
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("missing log → []", async () => {
	const dir = await tmp();
	try {
		expect(await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat" })).toEqual([]);
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test("tallyPlanVoteRound adapts the folded round straight into computeVoteQuorum", async () => {
	const dir = await tmp();
	try {
		const round = await openPlanVoteRound(dir, { featureId: "feat", repo: "/r", planPath: "p.md", candidateId: "c1", baseSha: "", revisionSha: "", assignees: ["a1", "a2", "a3"], openedBy: "a1" });
		await castPlanVote(dir, round.id, "a1", "approve");
		await castPlanVote(dir, round.id, "a2", "approve");
		const [got] = await listPlanVoteRounds(dir, { repo: "/r", featureId: "feat" });
		const quorum = tallyPlanVoteRound(got!);
		expect(quorum).toMatchObject({ assignees: 3, approvals: 2, rejects: 0, pending: 1, decided: true, passed: true });
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

// ── planVoteGateOpen (the server-side mirror of webapp's reviewGateOpen) ──────────────────────────

function comment(over: Partial<ArtifactComment>): ArtifactComment {
	return { id: "c1", repo: "/r", subject: "feat", body: "x", author: "a1", createdAt: 1, kind: "plan-annotation", annotation: { planPath: "plans/x/01.md" }, ...over };
}

test("planVoteGateOpen: false with zero doc-anchored comments (matches webapp's reviewGateOpen)", () => {
	expect(planVoteGateOpen([], "plans/x/01.md")).toBe(false);
});

test("planVoteGateOpen: false while any doc-anchored comment is unresolved", () => {
	const comments = [comment({ id: "a", resolvedAt: 1 }), comment({ id: "b" })];
	expect(planVoteGateOpen(comments, "plans/x/01.md")).toBe(false);
});

test("planVoteGateOpen: true once every doc-anchored comment is resolved", () => {
	const comments = [comment({ id: "a", resolvedAt: 1 }), comment({ id: "b", resolvedAt: 2 })];
	expect(planVoteGateOpen(comments, "plans/x/01.md")).toBe(true);
});

test("planVoteGateOpen: ignores comments anchored to a different doc, or non-annotation comments", () => {
	const comments = [
		comment({ id: "a", resolvedAt: 1, annotation: { planPath: "plans/OTHER.md" } }),
		comment({ id: "b", kind: "comment", annotation: undefined }),
	];
	expect(planVoteGateOpen(comments, "plans/x/01.md")).toBe(false); // no relevant comments at all ⇒ closed
});
