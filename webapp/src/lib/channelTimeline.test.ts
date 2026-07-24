import { describe, expect, test } from 'bun:test';
import { channelCardActionHref, dispatchChannelCard, latestChannelSeq, reduceChannelEntryWindow } from './channelTimeline';
import type { ChannelEntry } from './dto';

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
