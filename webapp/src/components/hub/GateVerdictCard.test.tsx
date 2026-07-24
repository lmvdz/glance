import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GateVerdictCard } from './GateVerdictCard';
import { dispatchChannelCard } from '../../lib/channelTimeline';
import type { ChannelEntry } from '../../lib/dto';

const entry: ChannelEntry = {
  id: 'entry-1',
  seq: 7,
  channelId: 'fleet',
  authorActor: 'manager',
  kind: 'system',
  text: 'gate verdict · pass · agreement 1.00 · confidence 0.92',
  ts: 1,
  status: 'ok',
  format: 'stage',
  event: {
    kind: 'gate-verdict',
    issuer: 'manager',
    payload: {
      refs: { unitId: 'unit-1' },
      face: {
        unitId: 'unit-1',
        unitName: 'Gate Door Unit',
        repo: '/repo',
        branch: 'squad/unit-1',
        verdict: 'pass',
        validation: {
          verdict: 'pass',
          agreement: 1,
          confidence: 0.92,
          rationale: 'All declared criteria satisfied.',
          perCriterion: [
            { id: 'C1', satisfied: true, note: 'card renders pinned payload' },
            { id: 'C2', satisfied: false, note: 'post-mortem still pending' },
          ],
          ranAt: 123,
        },
      },
    },
  },
};

test('GateVerdictCard renders pinned verdict material without answer controls', () => {
  const view = dispatchChannelCard(entry);
  const html = renderToStaticMarkup(<GateVerdictCard view={view} />);

  expect(html).toContain('Gate Door Unit');
  expect(html).toContain('All declared criteria satisfied.');
  expect(html).toContain('gate verdict');
  expect(html).toContain('pass');
  expect(html).toContain('Agreement');
  expect(html).toContain('100%');
  expect(html).toContain('Confidence');
  expect(html).toContain('92%');
  expect(html).toContain('C1');
  expect(html).toContain('card renders pinned payload');
  expect(html).toContain('C2');
  expect(html).toContain('post-mortem still pending');
  expect(html).toContain('href="#/gate-verdict/fleet/entry-1"');
  expect(html).not.toContain('Submit');
  expect(html).not.toContain('Answer');
});
