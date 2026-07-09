/**
 * Append-only plan-vote-round log — mirrors comments.ts's discipline EXACTLY: an event (open/cast/
 * close) is appended, never mutated in place, and every read folds the whole log into current
 * state. A round is the majority-of-assignees gate a `PlanRevisionCandidate` must clear before a
 * commit lands it (PLAN-VOTE-COMMIT.md §A/§F); `plan-vote-quorum.ts` owns the pass/fail arithmetic
 * this module only stores the raw casts for.
 *
 * ponytail: append-only JSONL under <stateDir>/plan-votes.jsonl, full-file scan + fold per read, no
 * rotation — same ceiling/upgrade-path note as comments.ts (move to sqlite only if it grows).
 */

import * as path from "node:path";
import type { ArtifactComment } from "./comments.ts";
import { getStorageBackend } from "./dal/storage.ts";
import type { PlanVoteCast, PlanVoteChoice, PlanVoteRound, PlanVoteState } from "./types.ts";
import { computeVoteQuorum, type VoteQuorum } from "./plan-vote-quorum.ts";

export function planVotesPath(baseDir: string): string {
	return path.join(baseDir, "plan-votes.jsonl");
}

// Monotonic id — same discipline as comments.ts's nextCommentId: strictly increasing per process
// even within one ms, since it doubles as the stable sort/lookup key.
let lastSeq = 0;
export function nextPlanVoteId(now = Date.now()): string {
	lastSeq = now > lastSeq ? now : lastSeq + 1;
	return `pv${lastSeq}`;
}

type OpenRoundSnapshot = Omit<PlanVoteRound, "state" | "casts" | "closedAt" | "closedReason">;

type PlanVoteEvent =
	| { type: "open"; round: OpenRoundSnapshot }
	| { type: "cast"; roundId: string; actorId: string; choice: PlanVoteChoice; at: number }
	| { type: "close"; roundId: string; state: Exclude<PlanVoteState, "voting">; at: number; reason?: string };

async function appendPlanVoteEvent(baseDir: string, ev: PlanVoteEvent): Promise<void> {
	await getStorageBackend().appendDurable(planVotesPath(baseDir), `${JSON.stringify(ev)}\n`);
}

export interface OpenPlanVoteInput {
	id?: string;
	featureId: string;
	repo: string;
	planPath: string;
	candidateId: string;
	baseSha: string;
	revisionSha: string;
	assignees: string[];
	openedBy: string;
	openedAt?: number;
	deadlineMs?: number;
}

/**
 * Open a new round. Pure append; the CALLER guards the business rules ("no existing open round",
 * "A>0", "reviewGateOpen") before calling this — mirrors `setAssignees`' "pure storage, caller
 * validates" contract. Returns the round exactly as a fold would see it right after (state
 * "voting", no casts yet).
 */
export async function openPlanVoteRound(baseDir: string, input: OpenPlanVoteInput): Promise<PlanVoteRound> {
	const openedAt = input.openedAt ?? Date.now();
	const round: OpenRoundSnapshot = {
		id: input.id ?? nextPlanVoteId(openedAt),
		featureId: input.featureId,
		repo: input.repo,
		planPath: input.planPath,
		candidateId: input.candidateId,
		baseSha: input.baseSha,
		revisionSha: input.revisionSha,
		assignees: [...new Set(input.assignees)],
		openedBy: input.openedBy,
		openedAt,
		deadlineMs: input.deadlineMs,
	};
	await appendPlanVoteEvent(baseDir, { type: "open", round });
	return { ...round, state: "voting", casts: [] };
}

/**
 * Append one assignee's cast. Idempotent per actor: casting twice just overwrites the fold (last
 * write wins) — no separate "already voted" error, same idempotent-append style as comments.ts's
 * resolve. Membership (`actorId` ∈ round.assignees) is the CALLER's job (the server's app-layer
 * check) — this function stores whatever it's given, same contract as `setAssignees`.
 */
export async function castPlanVote(baseDir: string, roundId: string, actorId: string, choice: PlanVoteChoice, at = Date.now()): Promise<void> {
	await appendPlanVoteEvent(baseDir, { type: "cast", roundId, actorId, choice, at });
}

/**
 * Close a round with a terminal state. Fold keeps the FIRST close event per round (see
 * `listPlanVoteRounds`), so a race between two triggers computing "decided" independently can
 * never flip an already-decided outcome — idempotent by construction, not by a read-before-write.
 */
export async function closePlanVoteRound(baseDir: string, roundId: string, state: Exclude<PlanVoteState, "voting">, reason?: string, at = Date.now()): Promise<void> {
	await appendPlanVoteEvent(baseDir, { type: "close", roundId, state, at, reason });
}

export interface PlanVoteQuery {
	repo?: string;
	featureId?: string;
}

/** Read the log, fold open+cast+close → current rounds, oldest-first (append order), filtered. */
export async function listPlanVoteRounds(baseDir: string, q: PlanVoteQuery = {}): Promise<PlanVoteRound[]> {
	const text = await getStorageBackend().readText(planVotesPath(baseDir));
	if (text === undefined) return [];
	const byId = new Map<string, PlanVoteRound>();
	const order: string[] = [];
	const castsByRound = new Map<string, Map<string, PlanVoteCast>>();
	const closed = new Set<string>(); // first close wins
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // skip a torn/partial trailing line rather than throw
		}
		const ev = parsed as PlanVoteEvent;
		if (ev.type === "open") {
			if (!byId.has(ev.round.id)) order.push(ev.round.id);
			byId.set(ev.round.id, { ...ev.round, state: "voting", casts: [] });
			if (!castsByRound.has(ev.round.id)) castsByRound.set(ev.round.id, new Map());
		} else if (ev.type === "cast") {
			const bucket = castsByRound.get(ev.roundId);
			if (bucket) bucket.set(ev.actorId, { actorId: ev.actorId, choice: ev.choice, at: ev.at });
		} else if (ev.type === "close") {
			if (closed.has(ev.roundId)) continue;
			closed.add(ev.roundId);
			const round = byId.get(ev.roundId);
			if (round) {
				round.state = ev.state;
				round.closedAt = ev.at;
				round.closedReason = ev.reason;
			}
		}
	}
	const out: PlanVoteRound[] = [];
	for (const id of order) {
		const round = byId.get(id);
		if (!round) continue;
		if (q.repo && round.repo !== q.repo) continue;
		if (q.featureId && round.featureId !== q.featureId) continue;
		round.casts = [...(castsByRound.get(id)?.values() ?? [])];
		out.push(round);
	}
	return out;
}

/** The currently-open (`state === "voting"`) round for a feature, or undefined. `/plan-vote/call`
 *  refuses a second call while one is open, so there is at most one at a time. */
export async function currentPlanVoteRound(baseDir: string, repo: string, featureId: string): Promise<PlanVoteRound | undefined> {
	const rounds = await listPlanVoteRounds(baseDir, { repo, featureId });
	return rounds.find((r) => r.state === "voting");
}

/** The quorum tally for one (already-folded) round — a thin adapter from `PlanVoteRound.casts`
 *  (an array) to the `Map` `computeVoteQuorum` wants. */
export function tallyPlanVoteRound(round: PlanVoteRound): VoteQuorum {
	const casts = new Map(round.casts.map((c) => [c.actorId, c.choice] as const));
	return computeVoteQuorum(round.assignees, casts);
}

/**
 * Server-side mirror of webapp's `reviewGateOpen` (webapp/src/lib/plan-doc-review.ts) — duplicated
 * rather than imported because webapp/ is a separate frontend package outside this backend's
 * tsconfig (`include: ["src"]` only). Keep the two in lockstep if the rule ever changes: the gate
 * is open once every doc-anchored plan-annotation comment on `docPath` is resolved, and there is at
 * least one (zero comments ⇒ gate stays closed, same as the webapp original).
 */
export function planVoteGateOpen(comments: readonly ArtifactComment[], docPath: string): boolean {
	const forDoc = comments.filter((c) => c.kind === "plan-annotation" && c.annotation?.planPath === docPath);
	return forDoc.length > 0 && forDoc.every((c) => c.resolvedAt !== undefined);
}
