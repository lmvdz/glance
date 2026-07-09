/**
 * Plan-vote — pure logic for the design-review screen's terminal vote panel
 * (DesignReviewView / `/review/:taskId`, PLAN-VOTE-COMMIT.md §C "Vote UI").
 *
 * All DOM-free derivation lives here so it's unit-tested without a browser, matching this
 * webapp's convention (lib/plan-doc-review.ts, lib/intervene.ts). The wire types below mirror
 * src/types.ts's `PlanVoteRound`/`PlanVoteCast`/`PlanVoteChoice`/`PlanVoteState` and
 * src/plan-vote-quorum.ts's `VoteQuorum` — duplicated rather than imported for the same reason
 * plan-votes.ts duplicates `reviewGateOpen`: webapp/ is a separate frontend package outside the
 * backend's tsconfig.
 */

import type { PlanRevisionCandidateStateDTO } from './dto';

export type PlanVoteChoiceDTO = 'approve' | 'reject';

/** This unit (V2's backend) only ever produces "voting" | "passed" | "rejected" — "expired" and
 *  "superseded" are reserved for a later unit (no expiry sweep / supersede-on-newer-candidate
 *  wiring exists yet). The UI still renders both defensively so it doesn't need a follow-up
 *  change the day that wiring lands. */
export type PlanVoteStateDTO = 'voting' | 'passed' | 'rejected' | 'expired' | 'superseded';

export interface PlanVoteCastDTO {
  actorId: string;
  choice: PlanVoteChoiceDTO;
  at: number;
}

export interface PlanVoteRoundDTO {
  id: string;
  featureId: string;
  repo: string;
  planPath: string;
  candidateId: string;
  baseSha: string;
  revisionSha: string;
  assignees: string[];
  openedBy: string;
  openedAt: number;
  deadlineMs?: number;
  state: PlanVoteStateDTO;
  casts: PlanVoteCastDTO[];
  closedAt?: number;
  closedReason?: string;
}

export interface VoteQuorumDTO {
  assignees: number;
  approvals: number;
  rejects: number;
  pending: number;
  decided: boolean;
  passed: boolean;
  reason: string;
}

export interface PlanVoteGetResponse {
  round: PlanVoteRoundDTO | null;
  quorum: VoteQuorumDTO | null;
}

// ── viewer identity (mirrors server.ts's actor.id resolution) ───────────────────────────────────

export type PlanVoteAuthMode = 'db' | 'file';

/** The vote-authz identity string the SERVER computes for the current viewer in DB mode
 *  (server.ts: `actor.id = db:${session.user.id}`). File mode has no client-visible per-user
 *  identity string at all — see `isViewerAssignee`, which handles that case structurally. */
export function viewerActorId(mode: PlanVoteAuthMode, dbUserId: string | undefined): string | undefined {
  return mode === 'db' && dbUserId ? `db:${dbUserId}` : undefined;
}

/**
 * Whether the current viewer may call/cast against this assignee roster.
 *  - DB mode: the viewer's `db:<userId>` must be IN the roster.
 *  - File mode: file-mode assignees are architecturally always the single operator identity
 *    (src/feature-assignees.ts's `invalidFileAssignees` rejects any other value) — whoever holds
 *    the daemon's bearer token IS that operator, so membership is unconditional once the roster
 *    is non-empty. Mirrors AssigneesEditor.tsx's file-mode branch, which never checks an explicit
 *    id either — there is structurally only one identity to be.
 */
export function isViewerAssignee(mode: PlanVoteAuthMode, actorId: string | undefined, assignees: readonly string[]): boolean {
  if (mode === 'file') return assignees.length > 0;
  return !!actorId && assignees.includes(actorId);
}

// ── candidate resolution (mirrors the server's own tie-break) ───────────────────────────────────

interface CandidateLike {
  id: string;
  state: PlanRevisionCandidateStateDTO;
  createdAt: number;
}

/** The most-recently-created OPEN ("candidate"-state) revision — matches the server's own
 *  tie-break in POST /plan-vote/call (`[...candidates].sort((a,b)=>b.createdAt-a.createdAt)[0]`),
 *  so "is there a head candidate to call a vote on" agrees with what the server would resolve. */
export function headOpenCandidate<T extends CandidateLike>(candidates: readonly T[]): T | undefined {
  return [...candidates].filter((c) => c.state === 'candidate').sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** The live state of one candidate by id (any state, not just "candidate") — what the terminal
 *  panel needs to tell "passed, awaiting commit" from "passed and committed" apart (V4 flips the
 *  round's own candidate to "accepted" once it lands; this unit never computes that transition,
 *  it only reads it). */
export function candidateStateById(candidates: readonly CandidateLike[], candidateId: string | undefined): PlanRevisionCandidateStateDTO | undefined {
  if (!candidateId) return undefined;
  return candidates.find((c) => c.id === candidateId)?.state;
}

// ── the terminal panel's state machine ───────────────────────────────────────────────────────────

export type VotePanelState =
  | 'hidden' // review gate not open — no vote panel at all (the pre-existing behavior)
  | 'no-candidate' // gate open, nothing to vote on — the legacy "Create implementation session" path
  | 'ready-to-call' // gate open, a head candidate exists, no vote in flight — "Call for vote"
  | 'voting' // a round is open — quorum line + chips + tally + cast controls
  | 'passed-pending' // round passed; V4's commit-on-pass hasn't landed the candidate yet
  | 'committed' // round passed AND the candidate is now "accepted" — implementation-session re-enabled
  | 'rejected' // round rejected — discarded, plan unchanged
  | 'expired'; // round expired/superseded — re-call to retry

export interface VotePanelInput {
  gateOpen: boolean;
  /** The current head OPEN candidate's id, if any (see `headOpenCandidate`). */
  headCandidateId: string | undefined;
  /** GET /plan-vote's round — the currently-voting round, or else the feature's last round ever
   *  (server's own tie-break); undefined when there has never been one. */
  round: PlanVoteRoundDTO | undefined;
  /** The LIVE state of `round.candidateId` (see `candidateStateById`) — undefined when `round` is
   *  undefined. */
  roundCandidateState: PlanRevisionCandidateStateDTO | undefined;
}

/**
 * The terminal panel's one state machine. A round only governs the panel while it's still
 * relevant to the CURRENT vote cycle: once it's terminal (not "voting") and a *different*,
 * fresh candidate has since become the head open one, the old round is retired — a new "Call for
 * vote" cycle starts clean (PLAN-VOTE-COMMIT.md §H3's "a newer candidate voids the round" intent;
 * the commit-on-pass unit hasn't wired the actual `superseded` transition yet, so this is the UI's
 * own defense against showing a stale terminal banner forever).
 */
export function votePanelState(input: VotePanelInput): VotePanelState {
  const { gateOpen, headCandidateId, round, roundCandidateState } = input;
  if (!gateOpen) return 'hidden';
  const roundIsStale = !!round && round.state !== 'voting' && headCandidateId !== undefined && round.candidateId !== headCandidateId;
  if (round && !roundIsStale) {
    switch (round.state) {
      case 'voting':
        return 'voting';
      case 'passed':
        return roundCandidateState === 'accepted' ? 'committed' : 'passed-pending';
      case 'rejected':
        return 'rejected';
      case 'expired':
      case 'superseded':
        return 'expired';
    }
  }
  return headCandidateId ? 'ready-to-call' : 'no-candidate';
}

/** Whether "Call for vote" should render (as an enabled control) for this panel state + viewer. */
export function canCallVote(state: VotePanelState, isAssignee: boolean): boolean {
  return isAssignee && (state === 'ready-to-call' || state === 'expired');
}

/** Whether the viewer may cast approve/reject right now. */
export function canCastVote(state: VotePanelState, isAssignee: boolean): boolean {
  return isAssignee && state === 'voting';
}

// ── quorum + tally lines ─────────────────────────────────────────────────────────────────────────

/** Strict-majority threshold for a roster of `total` assignees — the smallest approval count that
 *  clears `approvals > total/2` (mirrors src/plan-vote-quorum.ts's `computeVoteQuorum` exactly). */
export function voteThreshold(total: number): number {
  return Math.floor(total / 2) + 1;
}

/** "Needs 2 of 3 assignees" — the quorum line. */
export function quorumLine(total: number): string {
  if (total <= 0) return 'No assignees';
  const need = voteThreshold(total);
  return `Needs ${need} of ${total} assignee${total === 1 ? '' : 's'}`;
}

/** "2 approve · 0 reject · 1 pending" — the live tally line. */
export function tallyLine(quorum: VoteQuorumDTO): string {
  return `${quorum.approvals} approve · ${quorum.rejects} reject · ${quorum.pending} pending`;
}

// ── per-assignee chips ───────────────────────────────────────────────────────────────────────────

export type AssigneeVoteState = 'pending' | 'approved' | 'rejected';

/** One assignee's current cast, folded from `round.casts` (already deduped/last-write-wins by the
 *  server's own fold — see plan-votes.ts). */
export function assigneeVoteState(assigneeId: string, round: Pick<PlanVoteRoundDTO, 'casts'>): AssigneeVoteState {
  const cast = round.casts.find((c) => c.actorId === assigneeId);
  if (!cast) return 'pending';
  return cast.choice === 'approve' ? 'approved' : 'rejected';
}

/** StatusChip tone per assignee vote state (kit contract: success = approved-green, danger =
 *  rejected, neutral = still-pending — see StatusChip.tsx's tone↔role map). */
export const ASSIGNEE_VOTE_TONE: Record<AssigneeVoteState, 'neutral' | 'success' | 'danger'> = {
  pending: 'neutral',
  approved: 'success',
  rejected: 'danger',
};

export const ASSIGNEE_VOTE_LABEL: Record<AssigneeVoteState, string> = {
  pending: 'pending',
  approved: 'approve',
  rejected: 'reject',
};

/** The viewer's own current cast on the open round, if any (undefined ⇒ they haven't voted, or
 *  aren't an assignee, or there's no round). */
export function viewerChoice(actorId: string | undefined, round: PlanVoteRoundDTO | undefined): PlanVoteChoiceDTO | undefined {
  if (!actorId || !round) return undefined;
  return round.casts.find((c) => c.actorId === actorId)?.choice;
}

// ── human-readable assignee labels (strip internal scheme noise) ────────────────────────────────

/** The user-id portion of an actor id: `db:<userId>` / `web:<role>` → `<userId>`/`<role>`; any
 *  id without a known scheme prefix passes through unchanged. Mirrors AssigneesEditor's `userIdOf`,
 *  extended to the `web:` scheme the file-mode operator/role actors also carry. */
export function stripActorScheme(actorId: string): string {
  const m = /^(?:db|web):(.+)$/.exec(actorId);
  return m ? m[1] : actorId;
}

/**
 * The label to render for one assignee's chip — clean human text, never internal scheme noise
 * (PLAN-VOTE-COMMIT.md §C's "per-assignee chips" read like the reference UIs, not `db:<uuid>`):
 *   - the viewer's own id → "You";
 *   - else a real display name from the org-member roster the DB-mode picker already fetches, keyed
 *     by the scheme-stripped user id, when one is known;
 *   - else the bare id with its `db:`/`web:` scheme prefix stripped.
 * The FULL id is still what authz/casting use — this is display-only.
 */
export function assigneeLabel(
  actorId: string,
  opts: { viewerId?: string; nameByUserId?: ReadonlyMap<string, string> } = {},
): string {
  if (opts.viewerId && actorId === opts.viewerId) return 'You';
  const bare = stripActorScheme(actorId);
  return opts.nameByUserId?.get(bare) ?? bare;
}

// ── the "Committed to plans/<dir>" terminal line ────────────────────────────────────────────────

/** The plan directory a round's `planPath` (a single markdown file, e.g. "plans/ctx/01-spec.md")
 *  lives under — what the committed terminal state names ("Committed to plans/ctx"). Falls back to
 *  the bare path when it has no directory component (defensive; every real plan doc has one). */
export function planDirOf(planPath: string): string {
  const idx = planPath.lastIndexOf('/');
  return idx === -1 ? planPath : planPath.slice(0, idx);
}
