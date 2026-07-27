import { describe, expect, test } from 'bun:test';
import { askedAgainLine, buildChannelThreadViews, channelCardActionHref, dispatchChannelCard, doorLabel, foldRepeatedAsks, groupLifecycleRuns, latestChannelSeq, pinnedChip, reduceChannelEntryWindow } from './channelTimeline';
import type { ChannelEntry } from './dto';
import { entryTimeLabel } from './hub';

const entry = (overrides: Partial<ChannelEntry> & Pick<ChannelEntry, 'id' | 'seq'>): ChannelEntry => ({
  id: overrides.id,
  seq: overrides.seq,
  channelId: 'fleet',
  authorActor: 'manager',
  kind: 'assistant',
  text: 'fallback text',
  ts: overrides.seq,
  ...overrides,
});

describe('channel timeline dispatch', () => {
  test('renders pointer cards from pinned face payload fields', () => {
    const card = dispatchChannelCard(entry({
      id: 'n1',
      seq: 1,
      event: { kind: 'needs-you', payload: { face: { title: 'Review gate', eyebrow: 'Needs you', body: 'Approve the run', detail: 'Waiting at validation.', tone: 'warning', pinned: { agent: 'room-08', verdict: 'held' } } } },
    }));
    expect(card.kind).toBe('needs-you');
    expect(card.title).toBe('Review gate');
    expect(card.body).toBe('Approve the run');
    expect(card.pinned).toEqual([{ label: 'Agent', value: 'room-08' }, { label: 'Verdict', value: 'held' }]);
  });

  test('needs-you cards link to the intervene hash route from projected refs', () => {
    const card = dispatchChannelCard(entry({
      id: 'n-route',
      seq: 2,
      event: { kind: 'needs-you', payload: { refs: { unitId: 'agent one' }, face: { title: 'Needs you', pinned: { agent: 'agent one', age: '2m', 'why stopped': 'Approve gate' } } } },
    }));
    expect(card.actionHref).toBe('#/intervene/agent%20one');
    expect(channelCardActionHref(card.entry)).toBe('#/intervene/agent%20one');
  });

  test('needs-you resolution is a separate success card, not a mutation of the original card', () => {
    const pending = dispatchChannelCard(entry({
      id: 'pending-card',
      seq: 3,
      text: 'needs you · Approve deploy',
      event: { kind: 'needs-you', payload: { refs: { unitId: 'ada' }, face: { title: 'Needs you · Approve deploy', body: 'Approve deploy', tone: 'warning', pinned: { 'why stopped': 'Approve deploy', agent: 'Ada', age: '4m' } } } },
    }));
    const resolved = dispatchChannelCard(entry({
      id: 'resolved-card',
      seq: 4,
      text: 'needs you resolved · Approve deploy',
      event: { kind: 'needs-you', payload: { refs: { unitId: 'ada' }, face: { title: 'Resolved · Approve deploy', body: 'Approve deploy', tone: 'success', status: 'resolved', pinned: { 'why stopped': 'Approve deploy', agent: 'Ada', age: '4m' } } } },
    }));
    expect(pending.id).toBe('pending-card');
    expect(pending.title).toBe('Needs you · Approve deploy');
    expect(pending.tone).toBe('warning');
    expect(resolved.id).toBe('resolved-card');
    expect(resolved.title).toBe('Resolved · Approve deploy');
    expect(resolved.tone).toBe('success');
  });

  test('plan cards route to the TaskDetail plan DAG', () => {
    const card = dispatchChannelCard(entry({
      id: 'p1',
      seq: 2,
      event: { kind: 'plan-card', payload: { doorSurface: 'plan', refs: { planId: 'feat 1' }, face: { title: 'the room', body: '14 concerns ready', pinned: { concerns: 14 } } } },
    }));
    expect(card.kind).toBe('plan-card');
    expect(card.title).toBe('the room');
    expect(card.href).toBe('#/workbench/task/feat%201');
    expect(card.pinned).toEqual([{ label: 'Concerns', value: '14' }]);
  });

  test('token-burn snapshots open the fleet economics door', () => {
    const card = dispatchChannelCard(entry({
      id: 'burn',
      seq: 4,
      event: { kind: 'token-burn-snapshot', payload: { face: { title: 'Token burn · Verifier', body: '1234 tokens · $0.9876', tone: 'info' } } },
    }));

    expect(card.kind).toBe('token-burn-snapshot');
    expect(card.title).toBe('Token burn · Verifier');
    expect(card.body).toBe('1234 tokens · $0.9876');
    expect(card.href).toBe('#/workbench/economics');
  });

  test('unknown event kinds become neutral fallback cards', () => {
    const card = dispatchChannelCard(entry({ id: 'future', seq: 2, event: { kind: 'future-proof', payload: { face: { title: 'Ignored' } } } }));
    expect(card.kind).toBe('unknown-event');
    expect(card.tone).toBe('neutral');
    expect(card.title).toBe('Future Proof');
    expect(card.body).toBe('fallback text');
  });

  test('land attempt cards render branch sha and target from the pinned face', () => {
    const card = dispatchChannelCard(entry({
      id: 'land-a',
      seq: 3,
      text: 'land attempt started',
      event: { kind: 'land-attempt', payload: { refs: { unitId: 'room-16', landId: 'attempt-1' }, face: { unitName: 'Room 16', branch: 'room-16-landcards', sha: 'abcdef1234567890', target: 'HEAD', stage: 'started' } } },
    }));
    expect(card.kind).toBe('land-attempt');
    expect(card.title).toBe('Land attempt started');
    expect(card.body).toContain('Room 16 is landing room-16-landcards into HEAD');
    expect(card.pinned).toEqual([{ label: 'Branch', value: 'room-16-landcards' }, { label: 'SHA', value: 'abcdef1234' }, { label: 'Target', value: 'HEAD' }, { label: 'Attempt', value: 'attempt-1' }]);
    expect(card.land).toMatchObject({ branch: 'room-16-landcards', sha: 'abcdef1234', target: 'HEAD' });
  });

  test('land assessment cards render risk and recommendation as the face proof', () => {
    const card = dispatchChannelCard(entry({
      id: 'land-b',
      seq: 4,
      text: 'land assessment rejected',
      event: { kind: 'land-assessment', payload: { refs: { unitId: 'room-16', landId: 'attempt-1' }, face: { unitName: 'Room 16', branch: 'room-16-landcards', risk: 'high', recommendation: 'Hold until branch is rebased.', detail: 'stale branch overlaps main', stage: 'rejected' } } },
    }));
    expect(card.kind).toBe('land-assessment');
    expect(card.title).toBe('Land assessment · High');
    expect(card.body).toBe('Hold until branch is rebased.');
    expect(card.detail).toBe('stale branch overlaps main');
    expect(card.pinned).toEqual([{ label: 'Risk', value: 'High' }, { label: 'Recommendation', value: 'Hold until branch is rebased.' }, { label: 'Branch', value: 'room-16-landcards' }, { label: 'Attempt', value: 'attempt-1' }]);
    expect(card.href).toBeUndefined();
  });

  test('land merge cards render PR mode and route to the proof surface', () => {
    const card = dispatchChannelCard(entry({
      id: 'land-c',
      seq: 5,
      text: 'land merge finalized',
      event: { kind: 'land-merge', payload: { refs: { unitId: 'room-16' }, face: { unitName: 'Room 16', branch: 'room-16-landcards', outcome: 'merged', prNumber: 91, prUrl: 'https://github.example/pr/91', doneProofVerified: 'green', detail: 'PR merged, scratch gate green' } } },
    }));
    expect(card.kind).toBe('land-merge');
    expect(card.title).toBe('Land merge · Merged');
    expect(card.body).toContain('via PR #91');
    expect(card.pinned).toEqual([{ label: 'Outcome', value: 'Merged' }, { label: 'PR', value: '#91' }, { label: 'Proof', value: 'Green' }, { label: 'Branch', value: 'room-16-landcards' }]);
    expect(card.href).toBe('#/proof/room-16');
    expect(card.land).toMatchObject({ outcome: 'Merged', prNumber: '91', prUrl: 'https://github.example/pr/91', doneProofVerified: 'Green' });
  });
});

describe('unit lifecycle cards', () => {
  const kinds = ['unit-spawned', 'unit-turn-finished', 'unit-failed', 'pr-opened', 'verification-ran'] as const;

  test('every lifecycle kind renders its reader and malformed payload stays neutral', () => {
    for (const [index, kind] of kinds.entries()) {
      const rendered = dispatchChannelCard(entry({ id: `lifecycle-${kind}`, seq: index + 1, event: { kind, payload: { refs: { unitId: 'room-27' }, face: { title: `${kind} title`, tone: kind === 'unit-failed' ? 'destructive' : 'info' } } } }));
      const malformed = dispatchChannelCard(entry({ id: `malformed-${kind}`, seq: index + 11, event: { kind, payload: null } }));
      expect(rendered.kind).toBe(kind);
      expect(rendered.title).toBe(`${kind} title`);
      expect(malformed.kind).toBe(kind);
      // Deliberate change: severity that comes from the KIND survives an unreadable payload. A
      // `unit-failed` whose payload did not parse is still a failure, and rendering it neutral is the
      // absence-as-answer bug — the payload was missing, so the card said nothing was wrong. Every
      // other lifecycle kind takes its severity from its payload and correctly falls back to neutral.
      expect(malformed.tone).toBe(kind === 'unit-failed' ? 'destructive' : 'neutral');
      expect(malformed.title).toBe(kind.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()));
    }
  });

  test('folds only consecutive lifecycle cards from the same unit', () => {
    const views = [
      dispatchChannelCard(entry({ id: 'a1', seq: 1, event: { kind: 'unit-spawned', payload: { refs: { unitId: 'a' }, face: { title: 'A spawned' } } } })),
      dispatchChannelCard(entry({ id: 'a2', seq: 2, event: { kind: 'verification-ran', payload: { refs: { unitId: 'a' }, face: { title: 'A verified' } } } })),
      dispatchChannelCard(entry({ id: 'b1', seq: 3, event: { kind: 'unit-spawned', payload: { refs: { unitId: 'b' }, face: { title: 'B spawned' } } } })),
      dispatchChannelCard(entry({ id: 'a3', seq: 4, event: { kind: 'pr-opened', payload: { refs: { unitId: 'a' }, face: { title: 'A PR' } } } })),
    ];
    expect(groupLifecycleRuns(views).map((run) => run.map((view) => view.id))).toEqual([['a1', 'a2'], ['b1'], ['a3']]);
  });
});

describe('channel attribution cards', () => {
  test('every dispatch shape carries the stamped author label', () => {
    const cards = [
      dispatchChannelCard(entry({ id: 'message', seq: 1, kind: 'user', authorActor: 'db:u1', authorDisplayName: 'Lars Operator', authorOrigin: 'local' })),
      dispatchChannelCard(entry({ id: 'unknown', seq: 2, authorActor: 'manager', authorDisplayName: 'Room Manager', event: { kind: 'future-proof', payload: {} } })),
      dispatchChannelCard(entry({ id: 'pointer', seq: 3, authorActor: 'agent:planner', authorDisplayName: 'Planner Bot', authorOrigin: 'agent', event: { kind: 'needs-you', payload: { face: { title: 'Review gate' } } } })),
    ];

    expect(cards.map((card) => [card.kind, card.authorLabel, card.title])).toEqual([
      ['message', 'Lars Operator · human', 'Lars Operator · human'],
      ['unknown-event', 'Room Manager · system', 'Future Proof'],
      ['needs-you', 'Planner Bot · agent', 'Review gate'],
    ]);
  });
});

describe('channel entry reduction', () => {
  test('merges reconnect resync batches without gaps or dupes', () => {
    const current = [entry({ id: 'a', seq: 1 }), entry({ id: 'b', seq: 2 })];
    const resync = [entry({ id: 'b', seq: 2, text: 'updated' }), entry({ id: 'c', seq: 3 }), entry({ id: 'x', seq: 4, channelId: 'other' })];
    const next = reduceChannelEntryWindow(current, resync, 'fleet');
    expect(next.map((item) => `${item.seq}:${item.id}:${item.text}`)).toEqual(['1:a:fallback text', '2:b:updated', '3:c:fallback text']);
    expect(latestChannelSeq(next)).toBe(3);
  });
});

describe('card body de-duplication', () => {
  test('a body that only repeats the title is dropped, not printed twice', () => {
    // The live #fleet channel rendered every needs-you card as the same sentence twice: the face
    // title and `entry.text` are built from the same pending title.
    const card = dispatchChannelCard(entry({
      id: 'dup',
      seq: 1,
      text: 'needs you · Allow tool: bash Command: bun run check…',
      event: { kind: 'needs-you', payload: { face: { title: 'Needs you · Allow tool: bash Command: bun run check' } } },
    }));
    expect(card.title).toBe('Needs you · Allow tool: bash Command: bun run check');
    expect(card.body).toBe('');
  });

  test('a body that adds information survives', () => {
    const card = dispatchChannelCard(entry({
      id: 'keep',
      seq: 2,
      event: { kind: 'needs-you', payload: { face: { title: 'Needs you · deploy approval', body: 'Target: production, 3 services' } } },
    }));
    expect(card.body).toBe('Target: production, 3 services');
  });

  test('pinned fields that restate the title are dropped too', () => {
    const card = dispatchChannelCard(entry({
      id: 'pin',
      seq: 3,
      event: { kind: 'needs-you', payload: { face: { title: 'Needs you · run the gate', pinned: { 'why stopped': 'run the gate', agent: 'room-18' } } } },
    }));
    expect(card.pinned.map((item) => item.label)).toEqual(['Agent']);
  });
});

describe('door labels', () => {
  test('each kind names where its door actually goes', () => {
    expect([doorLabel('plan-card'), doorLabel('token-burn-snapshot'), doorLabel('needs-you'), doorLabel('what-is-this')])
      .toEqual(['Open plan DAG', 'Open fleet economics', 'Step into the agent', 'Open']);
  });

  test('a token-burn card never offers to open a plan DAG', () => {
    const card = dispatchChannelCard(entry({ id: 'tb', seq: 4, event: { kind: 'token-burn-snapshot', payload: { face: { title: 'Fleet burn' } } } }));
    expect(card.href).toBe('#/workbench/economics');
    expect(doorLabel(card.kind)).toBe('Open fleet economics');
  });
});

describe('pinned chip identity', () => {
  test('keeps complete repo and generated branch addresses on demand', () => {
    expect(pinnedChip('Repo', '/home/lars/src/omp-squad')).toEqual({
      label: 'Repo',
      value: 'omp-squad',
      full: '/home/lars/src/omp-squad',
    });
    expect(pinnedChip('Branch', 'squad/rail-earns-its-place-ms14z9hk-4-f9abafdc')).toEqual({
      label: 'Branch',
      value: 'rail-earns-its-place',
      full: 'squad/rail-earns-its-place-ms14z9hk-4-f9abafdc',
    });
  });

  test('applies the same address-on-demand rule to land-card branch chips', () => {
    const card = dispatchChannelCard(entry({
      id: 'land-branch',
      seq: 4,
      event: { kind: 'land-attempt', payload: { refs: { unitId: 'room-09' }, face: { branch: 'squad/rail-earns-its-place-ms14z9hk-4-f9abafdc' } } },
    }));
    expect(card.pinned).toContainEqual({
      label: 'Branch',
      value: 'rail-earns-its-place',
      full: 'squad/rail-earns-its-place-ms14z9hk-4-f9abafdc',
    });
  });
});

describe('foldRepeatedAsks', () => {
  const ask = (id: string, ts: number, title: string, agent: string): ChannelEntry => ({
    id, seq: ts, channelId: 'fleet', authorActor: 'manager', kind: 'system', text: title, ts,
    event: { kind: 'needs-you', payload: { face: { title, pinned: { agent } } } },
  } as ChannelEntry);

  test('the room does not ask the same question twice', () => {
    // Seen live: one unanswered question rendered as two identical cards two minutes apart, while
    // the alarm band was already carrying it. Three copies of one question.
    const views = buildChannelThreadViews([
      ask('a', 1, 'Needs you · Approve plan', 'ompsq-480'),
      ask('b', 2, 'Needs you · Approve plan', 'ompsq-480'),
      ask('c', 3, 'Needs you · Approve plan', 'ompsq-480'),
    ]);
    expect(views).toHaveLength(1);
    // The FIRST card survives: when it was first asked is the fact worth keeping.
    expect(views[0]!.id).toBe('a');
    expect(views[0]!.askedAgain).toBe(2);
    expect(views[0]!.lastAskedAt).toBe(3);
  });

  test('two different questions from one agent are two things to answer', () => {
    const views = buildChannelThreadViews([
      ask('a', 1, 'Needs you · Approve plan', 'ompsq-480'),
      ask('b', 2, 'Needs you · Allow tool: bash', 'ompsq-480'),
    ]);
    expect(views).toHaveLength(2);
  });

  test('the same question from two agents is two things to answer', () => {
    const views = buildChannelThreadViews([
      ask('a', 1, 'Needs you · Approve plan', 'ompsq-480'),
      ask('b', 2, 'Needs you · Approve plan', 'ompsq-479'),
    ]);
    expect(views).toHaveLength(2);
  });

  test('only needs-you folds — an ordinary message repeating itself is still two messages', () => {
    const message = (id: string, ts: number): ChannelEntry => ({ id, seq: ts, channelId: 'fleet', authorActor: 'db:u1', kind: 'user', text: 'ok', ts } as ChannelEntry);
    expect(buildChannelThreadViews([message('a', 1), message('b', 2)])).toHaveLength(2);
  });

  test('the folded card says it plainly, once', () => {
    expect(askedAgainLine({ askedAgain: 1, lastAskedAt: undefined })).toContain('Asked again once');
    expect(askedAgainLine({ askedAgain: 3, lastAskedAt: undefined })).toContain('Asked again 3 times');
    expect(askedAgainLine({ askedAgain: 0 })).toBeUndefined();
    expect(askedAgainLine({})).toBeUndefined();
  });
});

test('the folded line uses the same clock as the card header', () => {
  // A card headed "20:48" carrying a line reading "08:57 PM" makes a reader stop and work out
  // whether those are even the same day.
  const at = new Date('2026-07-26T20:57:00').getTime();
  const line = askedAgainLine({ askedAgain: 2, lastAskedAt: at }, at)!;
  expect(line).toContain(entryTimeLabel(at, at));
});
