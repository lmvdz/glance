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

test('GateVerdictCard cites the reviewer-precision receipt line when present (glance#332)', () => {
  const withPrecision: ChannelEntry = {
    ...entry,
    event: {
      ...entry.event!,
      payload: {
        ...(entry.event!.payload as Record<string, unknown>),
        face: {
          ...(entry.event!.payload as { face: Record<string, unknown> }).face,
          validation: {
            ...(entry.event!.payload as { face: { validation: Record<string, unknown> } }).face.validation,
            reviewerPrecision: { lineage: 'codex', n: 52, survived: 39, survivedRate: 0.75, provisional: false },
          },
        },
      },
    },
  };
  const view = dispatchChannelCard(withPrecision);
  const html = renderToStaticMarkup(<GateVerdictCard view={view} />);
  expect(html).toContain('Reviewer precision');
  expect(html).toContain('codex, measured precision 75% (n=52 adjudicated rows)');
});

test('GateVerdictCard never fabricates a 0% for an unmeasured (n=0) reviewer-precision stamp', () => {
  const withZero: ChannelEntry = {
    ...entry,
    event: {
      ...entry.event!,
      payload: {
        ...(entry.event!.payload as Record<string, unknown>),
        face: {
          ...(entry.event!.payload as { face: Record<string, unknown> }).face,
          validation: {
            ...(entry.event!.payload as { face: { validation: Record<string, unknown> } }).face.validation,
            reviewerPrecision: { lineage: 'grok', n: 0, survived: 0, provisional: true },
          },
        },
      },
    },
  };
  const view = dispatchChannelCard(withZero);
  const html = renderToStaticMarkup(<GateVerdictCard view={view} />);
  // Base fixture's Agreement/Confidence tiles legitimately show "100%"/"92%" (containing the substring
  // "0%"), so the assertion targets the precision line itself, not the whole page.
  expect(html).toContain('grok, unmeasured (n=0)');
  expect(html).not.toContain('n=0, rate unavailable');
});
