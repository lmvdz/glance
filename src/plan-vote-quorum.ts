/**
 * Plan-vote quorum math — pure, exhaustively-unit-tested majority-of-assignees arithmetic for a
 * `PlanVoteRound` (see plan-votes.ts, types.ts). Mirrors the discipline of webapp's
 * lib/plan-doc-review.ts: all derivation lives in one dependency-free function so the CONFIRMED
 * rules (PLAN-VOTE-COMMIT.md §B, user-confirmed) are pinned by a boundary table, not read off a
 * live server. No I/O, no imports beyond types — safe to unit-test without a stateDir or a server.
 *
 * The confirmed rules:
 *   - Pass = strict majority of the FULL assignee set: approvals > assignees/2. Abstention (an
 *     assignee who never casts) counts as NOT approve — silence must never commit to a shared plan.
 *   - A=1 (solo assignee, e.g. file mode): the one approval auto-passes (1 > 0.5) — the CALLER
 *     audits this and labels it "sole assignee auto-pass"; it is never silent.
 *   - A=0: the `/plan-vote/call` endpoint refuses to open a round at all (a guard AT CALL, not
 *     here). This function still returns a total, sane answer for A=0 as defense in depth — never
 *     `passed` — but that branch should be unreachable in practice.
 *   - A tie (approvals === assignees/2 exactly) fails the strict `>` — no coin flip, ever.
 *   - `decided` goes true the instant the outcome is mathematically fixed, even before every
 *     assignee has cast — a round auto-closes on the deciding vote, not on full turnout.
 */

export type VoteChoice = "approve" | "reject";

export interface VoteQuorum {
	/** Size of the (deduped) assignee roster — the quorum denominator. */
	assignees: number;
	approvals: number;
	rejects: number;
	/** Assignees who haven't cast (or whose cast isn't counted — see `computeVoteQuorum`'s doc). */
	pending: number;
	/** True once the outcome is mathematically fixed regardless of any outstanding vote. */
	decided: boolean;
	/** True once `decided` and approvals cleared the strict majority. */
	passed: boolean;
	/** One-line human explanation, stable enough to assert on in tests and to audit-log verbatim. */
	reason: string;
}

/**
 * `assignees` is the round's snapshotted roster (a later live-roster change never reweights an
 * open round — see PlanVoteRound's doc). `casts` is keyed by actorId → choice, already
 * deduped/last-write-wins by the caller's fold (plan-votes.ts's `listPlanVoteRounds`). Only casts
 * whose actorId is IN `assignees` count — a cast from someone since dropped off the roster is
 * silently excluded (not an error): the roster is a point-in-time snapshot the caller controls.
 */
export function computeVoteQuorum(assignees: readonly string[], casts: ReadonlyMap<string, VoteChoice>): VoteQuorum {
	const roster = new Set(assignees);
	const total = roster.size;
	let approvals = 0;
	let rejects = 0;
	for (const id of roster) {
		const choice = casts.get(id);
		if (choice === "approve") approvals++;
		else if (choice === "reject") rejects++;
	}
	const pending = total - approvals - rejects;
	const passed = approvals * 2 > total;
	// decided ⇔ passed already, OR even a unanimous "approve" from every still-pending assignee
	// couldn't clear the strict majority — i.e. the best-case approval total still falls short.
	const decided = passed || (approvals + pending) * 2 <= total;
	const reason = !decided
		? `pending — ${approvals}/${total} approved so far (${pending} outstanding), needs > ${total}/2`
		: total === 0
			? "no assignees — cannot decide"
			: passed && total === 1
				? "sole assignee auto-pass (1 > 0.5)"
				: passed
					? `passed — ${approvals}/${total} approved (> ${total}/2)`
					: approvals === rejects && approvals * 2 === total
						? `tied ${approvals}-${rejects} of ${total} — fails the strict majority`
						: `failed — ${approvals}/${total} approved, needs > ${total}/2`;
	return { assignees: total, approvals, rejects, pending, decided, passed, reason };
}
