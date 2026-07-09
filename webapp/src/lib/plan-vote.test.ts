import { describe, expect, it } from 'bun:test';
import {
  ASSIGNEE_VOTE_LABEL,
  ASSIGNEE_VOTE_TONE,
  assigneeLabel,
  assigneeVoteState,
  candidateStateById,
  canCallVote,
  canCastVote,
  headOpenCandidate,
  isViewerAssignee,
  planDirOf,
  quorumLine,
  stripActorScheme,
  tallyLine,
  viewerActorId,
  viewerChoice,
  votePanelState,
  voteThreshold,
  type PlanVoteRoundDTO,
  type VoteQuorumDTO,
} from './plan-vote';

function round(over: Partial<PlanVoteRoundDTO> = {}): PlanVoteRoundDTO {
  return {
    id: 'pv1',
    featureId: 'feat-1',
    repo: '/repo',
    planPath: 'plans/x/01.md',
    candidateId: 'c1',
    baseSha: 'sha1',
    revisionSha: 'sha2',
    assignees: ['db:u1', 'db:u2', 'db:u3'],
    openedBy: 'db:u1',
    openedAt: 1,
    state: 'voting',
    casts: [],
    ...over,
  };
}

function quorum(over: Partial<VoteQuorumDTO> = {}): VoteQuorumDTO {
  return { assignees: 3, approvals: 0, rejects: 0, pending: 3, decided: false, passed: false, reason: 'pending', ...over };
}

// ── viewer identity ──────────────────────────────────────────────────────────────────────────────

describe('viewerActorId', () => {
  it('db mode: db:<userId>', () => {
    expect(viewerActorId('db', 'u1')).toBe('db:u1');
  });
  it('db mode with no user id: undefined', () => {
    expect(viewerActorId('db', undefined)).toBeUndefined();
  });
  it('file mode: always undefined (no client-visible per-user identity)', () => {
    expect(viewerActorId('file', 'u1')).toBeUndefined();
  });
});

describe('isViewerAssignee', () => {
  it('db mode: true only when the viewer id is in the roster', () => {
    expect(isViewerAssignee('db', 'db:u1', ['db:u1', 'db:u2'])).toBe(true);
    expect(isViewerAssignee('db', 'db:u9', ['db:u1', 'db:u2'])).toBe(false);
    expect(isViewerAssignee('db', undefined, ['db:u1'])).toBe(false);
  });
  it('file mode: unconditionally true once the roster is non-empty (single-operator substrate)', () => {
    expect(isViewerAssignee('file', undefined, ['local'])).toBe(true);
  });
  it('file mode: false for an (unreachable, defense-in-depth) empty roster', () => {
    expect(isViewerAssignee('file', undefined, [])).toBe(false);
  });
});

// ── candidate resolution ─────────────────────────────────────────────────────────────────────────

describe('headOpenCandidate', () => {
  it('picks the most-recently-created "candidate"-state revision', () => {
    const candidates = [
      { id: 'c1', state: 'candidate' as const, createdAt: 1 },
      { id: 'c2', state: 'candidate' as const, createdAt: 5 },
      { id: 'c3', state: 'accepted' as const, createdAt: 9 },
    ];
    expect(headOpenCandidate(candidates)?.id).toBe('c2');
  });
  it('undefined when nothing is open', () => {
    expect(headOpenCandidate([{ id: 'c1', state: 'accepted' as const, createdAt: 1 }])).toBeUndefined();
  });
  it('undefined for an empty list', () => {
    expect(headOpenCandidate([])).toBeUndefined();
  });
});

describe('candidateStateById', () => {
  const candidates = [
    { id: 'c1', state: 'accepted' as const, createdAt: 1 },
    { id: 'c2', state: 'candidate' as const, createdAt: 2 },
  ];
  it('finds by id regardless of state', () => {
    expect(candidateStateById(candidates, 'c1')).toBe('accepted');
  });
  it('undefined for an unknown id or no id', () => {
    expect(candidateStateById(candidates, 'nope')).toBeUndefined();
    expect(candidateStateById(candidates, undefined)).toBeUndefined();
  });
});

// ── the terminal panel's state machine ──────────────────────────────────────────────────────────

describe('votePanelState', () => {
  it('hidden when the review gate is not open', () => {
    expect(votePanelState({ gateOpen: false, headCandidateId: 'c1', round: undefined, roundCandidateState: undefined })).toBe('hidden');
  });

  it('no-candidate when the gate is open but nothing to vote on', () => {
    expect(votePanelState({ gateOpen: true, headCandidateId: undefined, round: undefined, roundCandidateState: undefined })).toBe('no-candidate');
  });

  it('ready-to-call when a head candidate exists and there is no round yet', () => {
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c1', round: undefined, roundCandidateState: undefined })).toBe('ready-to-call');
  });

  it('voting while a round is open', () => {
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c1', round: round({ candidateId: 'c1', state: 'voting' }), roundCandidateState: 'candidate' })).toBe('voting');
  });

  it('passed-pending once the round passes but V4 has not yet flipped the candidate to accepted', () => {
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c1', round: round({ candidateId: 'c1', state: 'passed' }), roundCandidateState: 'candidate' })).toBe('passed-pending');
  });

  it('committed once the round passed AND the candidate is accepted', () => {
    // The candidate is no longer "candidate"-state, so it's no longer the head OPEN one.
    expect(votePanelState({ gateOpen: true, headCandidateId: undefined, round: round({ candidateId: 'c1', state: 'passed' }), roundCandidateState: 'accepted' })).toBe('committed');
  });

  it('rejected persists until a fresh candidate replaces the discarded one', () => {
    expect(votePanelState({ gateOpen: true, headCandidateId: undefined, round: round({ candidateId: 'c1', state: 'rejected' }), roundCandidateState: 'rejected' })).toBe('rejected');
  });

  it('expired/superseded both render as "expired" (re-call to retry)', () => {
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c1', round: round({ candidateId: 'c1', state: 'expired' }), roundCandidateState: 'candidate' })).toBe('expired');
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c1', round: round({ candidateId: 'c1', state: 'superseded' }), roundCandidateState: 'candidate' })).toBe('expired');
  });

  it('a stale terminal round (a NEW head candidate has since appeared) is retired back to ready-to-call', () => {
    const stale = round({ candidateId: 'c-old', state: 'rejected' });
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c-new', round: stale, roundCandidateState: 'rejected' })).toBe('ready-to-call');
  });

  it('a still-VOTING round is never treated as stale, even if a fresher candidate id would otherwise disagree', () => {
    const voting = round({ candidateId: 'c-old', state: 'voting' });
    expect(votePanelState({ gateOpen: true, headCandidateId: 'c-old', round: voting, roundCandidateState: 'candidate' })).toBe('voting');
  });
});

describe('canCallVote / canCastVote', () => {
  it('call is only offered to an assignee in ready-to-call or expired', () => {
    expect(canCallVote('ready-to-call', true)).toBe(true);
    expect(canCallVote('expired', true)).toBe(true);
    expect(canCallVote('ready-to-call', false)).toBe(false);
    expect(canCallVote('voting', true)).toBe(false);
    expect(canCallVote('hidden', true)).toBe(false);
  });

  it('cast is only offered to an assignee while voting', () => {
    expect(canCastVote('voting', true)).toBe(true);
    expect(canCastVote('voting', false)).toBe(false);
    expect(canCastVote('ready-to-call', true)).toBe(false);
    expect(canCastVote('passed-pending', true)).toBe(false);
  });
});

// ── quorum + tally lines ─────────────────────────────────────────────────────────────────────────

describe('voteThreshold / quorumLine', () => {
  it('matches the server\'s strict-majority arithmetic at the documented boundaries', () => {
    expect(voteThreshold(1)).toBe(1);
    expect(voteThreshold(2)).toBe(2); // unanimous, deliberate
    expect(voteThreshold(3)).toBe(2);
    expect(voteThreshold(4)).toBe(3);
  });

  it('renders the quorum line, singular-safe', () => {
    expect(quorumLine(1)).toBe('Needs 1 of 1 assignee');
    expect(quorumLine(3)).toBe('Needs 2 of 3 assignees');
    expect(quorumLine(4)).toBe('Needs 3 of 4 assignees');
  });

  it('degenerate A=0 renders a plain message rather than nonsense arithmetic', () => {
    expect(quorumLine(0)).toBe('No assignees');
  });
});

describe('tallyLine', () => {
  it('renders the live tally', () => {
    expect(tallyLine(quorum({ approvals: 2, rejects: 0, pending: 1 }))).toBe('2 approve · 0 reject · 1 pending');
  });
});

// ── per-assignee chips ───────────────────────────────────────────────────────────────────────────

describe('assigneeVoteState', () => {
  it('pending when the assignee has not cast', () => {
    expect(assigneeVoteState('db:u3', round({ casts: [{ actorId: 'db:u1', choice: 'approve', at: 1 }] }))).toBe('pending');
  });
  it('approved / rejected reflect the folded cast', () => {
    const r = round({ casts: [{ actorId: 'db:u1', choice: 'approve', at: 1 }, { actorId: 'db:u2', choice: 'reject', at: 2 }] });
    expect(assigneeVoteState('db:u1', r)).toBe('approved');
    expect(assigneeVoteState('db:u2', r)).toBe('rejected');
  });

  it('tone/label tables cover every state', () => {
    expect(ASSIGNEE_VOTE_TONE.pending).toBe('neutral');
    expect(ASSIGNEE_VOTE_TONE.approved).toBe('success');
    expect(ASSIGNEE_VOTE_TONE.rejected).toBe('danger');
    expect(ASSIGNEE_VOTE_LABEL.approved).toBe('approve');
  });
});

describe('viewerChoice', () => {
  it('undefined with no actor id, no round, or no cast yet', () => {
    expect(viewerChoice(undefined, round())).toBeUndefined();
    expect(viewerChoice('db:u1', undefined)).toBeUndefined();
    expect(viewerChoice('db:u1', round())).toBeUndefined();
  });
  it('returns the viewer\'s own folded cast', () => {
    const r = round({ casts: [{ actorId: 'db:u1', choice: 'reject', at: 1 }] });
    expect(viewerChoice('db:u1', r)).toBe('reject');
  });
});

describe('stripActorScheme', () => {
  it('strips db: and web: scheme prefixes', () => {
    expect(stripActorScheme('db:u1')).toBe('u1');
    expect(stripActorScheme('web:admin')).toBe('admin');
  });
  it('passes a schemeless id through unchanged', () => {
    expect(stripActorScheme('local')).toBe('local');
  });
});

describe('assigneeLabel', () => {
  it('renders "You" for the viewer\'s own id', () => {
    expect(assigneeLabel('db:kyle', { viewerId: 'db:kyle' })).toBe('You');
  });
  it('prefers a real display name from the roster (keyed by scheme-stripped id)', () => {
    const names = new Map([['sarah', 'Sarah Connor']]);
    expect(assigneeLabel('db:sarah', { viewerId: 'db:kyle', nameByUserId: names })).toBe('Sarah Connor');
  });
  it('falls back to the id WITHOUT its scheme prefix — never raw db:/web: noise', () => {
    expect(assigneeLabel('db:mo', {})).toBe('mo');
    expect(assigneeLabel('web:admin', { nameByUserId: new Map() })).toBe('admin');
  });
  it('"You" wins even when a name is also known for the viewer', () => {
    const names = new Map([['kyle', 'Kyle Reese']]);
    expect(assigneeLabel('db:kyle', { viewerId: 'db:kyle', nameByUserId: names })).toBe('You');
  });
});

describe('planDirOf', () => {
  it('strips the file name off a plan path', () => {
    expect(planDirOf('plans/ctx/01-spec.md')).toBe('plans/ctx');
  });
  it('falls back to the bare path when there is no directory component', () => {
    expect(planDirOf('spec.md')).toBe('spec.md');
  });
});
