/**
 * Plan-vote quorum math boundary table — verbatim from PLAN-VOTE-COMMIT.md §B (user-confirmed):
 *   - A=1: the sole assignee's one approval auto-passes.
 *   - A=2: unanimous (need 2 of 2) — a 1-1 split is a tie, and ties fail.
 *   - A=3: need 2 of 3.
 *   - A=4: need 3 of 4 — a 2-2 split is a tie, and ties fail.
 *   - Abstention (no cast at all) counts as not-approve.
 *   - A round is `decided` the instant the outcome can no longer change, even before every
 *     assignee has cast (early auto-close on the deciding vote).
 */
import { describe, expect, test } from "bun:test";
import { computeVoteQuorum, type VoteChoice } from "../src/plan-vote-quorum.ts";

function roster(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `a${i + 1}`);
}

/** Build a casts Map from a roster + an array of choices (undefined ⇒ no cast / abstain). */
function castsFor(names: string[], choices: (VoteChoice | undefined)[]): Map<string, VoteChoice> {
	const m = new Map<string, VoteChoice>();
	names.forEach((name, i) => {
		const c = choices[i];
		if (c) m.set(name, c);
	});
	return m;
}

describe("computeVoteQuorum — the confirmed boundary table", () => {
	test("A=1: the sole assignee's approval auto-passes (1 > 0.5)", () => {
		const [a] = roster(1);
		const q = computeVoteQuorum([a], castsFor([a], ["approve"]));
		expect(q).toMatchObject({ assignees: 1, approvals: 1, rejects: 0, pending: 0, decided: true, passed: true });
		expect(q.reason).toContain("sole assignee auto-pass");
	});

	test("A=1: a reject fails, decided (nothing pending, no coin flip)", () => {
		const [a] = roster(1);
		const q = computeVoteQuorum([a], castsFor([a], ["reject"]));
		expect(q).toMatchObject({ assignees: 1, approvals: 0, rejects: 1, pending: 0, decided: true, passed: false });
	});

	test("A=1: uncast — pending, not decided", () => {
		const [a] = roster(1);
		const q = computeVoteQuorum([a], castsFor([a], [undefined]));
		expect(q).toMatchObject({ assignees: 1, pending: 1, decided: false, passed: false });
	});

	test("A=2: unanimous 2-0 passes", () => {
		const names = roster(2);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "approve"]));
		expect(q).toMatchObject({ assignees: 2, approvals: 2, rejects: 0, pending: 0, decided: true, passed: true });
	});

	test("A=2: a 1-1 tie fails the strict majority (no coin flip)", () => {
		const names = roster(2);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "reject"]));
		expect(q).toMatchObject({ assignees: 2, approvals: 1, rejects: 1, pending: 0, decided: true, passed: false });
		expect(q.reason).toContain("tied");
	});

	test("A=2: 0-2 rejects, decided fail", () => {
		const names = roster(2);
		const q = computeVoteQuorum(names, castsFor(names, ["reject", "reject"]));
		expect(q).toMatchObject({ assignees: 2, approvals: 0, rejects: 2, pending: 0, decided: true, passed: false });
	});

	test("A=2: 1 approve, 1 still pending — undecided (could still reach 2)", () => {
		const names = roster(2);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", undefined]));
		expect(q).toMatchObject({ assignees: 2, approvals: 1, pending: 1, decided: false, passed: false });
	});

	test("A=3: 2 of 3 approve passes — and decides EARLY (1 still pending)", () => {
		const names = roster(3);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "approve", undefined]));
		expect(q).toMatchObject({ assignees: 3, approvals: 2, rejects: 0, pending: 1, decided: true, passed: true });
	});

	test("A=3: 2 of 3 reject fails — and decides EARLY (1 still pending, best case is 1/3)", () => {
		const names = roster(3);
		const q = computeVoteQuorum(names, castsFor(names, [undefined, "reject", "reject"]));
		expect(q).toMatchObject({ assignees: 3, approvals: 0, rejects: 2, pending: 1, decided: true, passed: false });
	});

	test("A=3: 1 approve, 1 reject, 1 pending — undecided (the pending vote is deciding)", () => {
		const names = roster(3);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "reject", undefined]));
		expect(q).toMatchObject({ assignees: 3, approvals: 1, rejects: 1, pending: 1, decided: false });
	});

	test("A=3: full turnout 1 approve 2 reject — decided fail", () => {
		const names = roster(3);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "reject", "reject"]));
		expect(q).toMatchObject({ assignees: 3, approvals: 1, rejects: 2, pending: 0, decided: true, passed: false });
	});

	test("A=4: 3 of 4 approve passes", () => {
		const names = roster(4);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "approve", "approve", "reject"]));
		expect(q).toMatchObject({ assignees: 4, approvals: 3, rejects: 1, pending: 0, decided: true, passed: true });
	});

	test("A=4: a 2-2 tie fails the strict majority", () => {
		const names = roster(4);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "approve", "reject", "reject"]));
		expect(q).toMatchObject({ assignees: 4, approvals: 2, rejects: 2, pending: 0, decided: true, passed: false });
		expect(q.reason).toContain("tied");
	});

	test("A=4: 2 approve, 2 still pending — undecided (could still reach 3 or 4)", () => {
		const names = roster(4);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "approve", undefined, undefined]));
		expect(q).toMatchObject({ assignees: 4, approvals: 2, pending: 2, decided: false, passed: false });
	});

	test("A=4: 2 approve, 1 reject, 1 pending — undecided (the pending vote could still make 3)", () => {
		const names = roster(4);
		const q = computeVoteQuorum(names, castsFor(names, ["approve", "approve", "reject", undefined]));
		expect(q).toMatchObject({ assignees: 4, approvals: 2, rejects: 1, pending: 1, decided: false });
	});

	test("A=4: 2 approve, 2 reject cast in full turnout with a redundant re-cast still ties (dedupe by actorId)", () => {
		const names = roster(4);
		// Map construction naturally dedupes; this documents that a caller passing a fold-deduped
		// map (as plan-votes.ts always does) never double-counts one actor.
		const casts = new Map<string, VoteChoice>([
			[names[0]!, "approve"],
			[names[1]!, "approve"],
			[names[2]!, "reject"],
			[names[3]!, "reject"],
		]);
		const q = computeVoteQuorum(names, casts);
		expect(q.decided).toBe(true);
		expect(q.passed).toBe(false);
	});

	test("A=0: never decided-passed (defense in depth — the /call endpoint refuses to open at A=0)", () => {
		const q = computeVoteQuorum([], new Map());
		expect(q).toMatchObject({ assignees: 0, approvals: 0, rejects: 0, pending: 0, decided: true, passed: false });
		expect(q.reason).toContain("no assignees");
	});

	test("a cast from someone not on the (snapshotted) roster is silently excluded, not counted", () => {
		const names = roster(3);
		const casts = castsFor(names, ["approve", undefined, undefined]);
		casts.set("stranger", "approve");
		const q = computeVoteQuorum(names, casts);
		expect(q.approvals).toBe(1); // the stranger's approve never counted
		expect(q.assignees).toBe(3);
	});

	test("duplicate names in the assignee list dedupe (Set), matching plan-votes.ts's snapshot dedupe", () => {
		const q = computeVoteQuorum(["a1", "a1", "a2"], castsFor(["a1", "a2"], ["approve", "approve"]));
		expect(q.assignees).toBe(2);
		expect(q.passed).toBe(true);
	});
});

describe("computeVoteQuorum — exhaustive property coverage (A=0..6, every approvals/rejects split)", () => {
	for (let total = 0; total <= 6; total++) {
		for (let approvals = 0; approvals <= total; approvals++) {
			for (let rejects = 0; rejects <= total - approvals; rejects++) {
				const pending = total - approvals - rejects;
				test(`A=${total} approvals=${approvals} rejects=${rejects} pending=${pending}`, () => {
					const names = roster(total);
					const choices: (VoteChoice | undefined)[] = [
						...Array(approvals).fill("approve" as const),
						...Array(rejects).fill("reject" as const),
						...Array(pending).fill(undefined),
					];
					const q = computeVoteQuorum(names, castsFor(names, choices));
					// Independent re-derivation of `passed` via real-number division (not the impl's
					// integer `*2` trick) — the actual rule text, computed a different way.
					expect(q.passed).toBe(approvals > total / 2);
					expect(q.pending).toBe(pending);
					expect(q.approvals).toBe(approvals);
					expect(q.rejects).toBe(rejects);
					// decided iff already passed, or no achievable future turnout can still pass.
					const bestCaseApprovals = approvals + pending;
					expect(q.decided).toBe(q.passed || !(bestCaseApprovals > total / 2));
				});
			}
		}
	}
});
