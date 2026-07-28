import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Task, TaskDecision } from '../../types';
import { DecisionsPanel } from './DecisionsPanel';

const T = 1_700_000_000_000;

function decision(over: Partial<TaskDecision>): TaskDecision {
  return { id: 'd1', text: 'text', ...over };
}

function criterion(over: Partial<Task['acceptanceCriteria'][number]>): Task['acceptanceCriteria'][number] {
  return { id: 'c1', text: 'criterion', completed: false, ...over };
}

test('renders every current decision and never renders the raw "none" word for an empty ledger', () => {
  const html = renderToStaticMarkup(<DecisionsPanel decisions={[]} criteria={[]} now={T} />);
  expect(html).toContain('DECISIONS');
  // House voice, not a bare "none" — matches QuietRoom's "first visit, not a quiet stretch" register.
  expect(html).toContain('first visit, not a quiet stretch');
  expect(html).not.toMatch(/>none</i);
});

test('splits current from superseded, keeping the current ledger un-struck', () => {
  const decisions = [
    decision({ id: 'live', text: 'use postgres', source: 'human', createdAt: T }),
    decision({ id: 'dead', text: 'use sqlite', source: 'human', createdAt: T - 10_000, supersededBy: 'live' }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />);
  expect(html).toContain('use postgres');
  expect(html).toContain('use sqlite');
  expect(html).toContain('1 current');
});

test('a superseded decision is visibly marked history, not hidden and not indistinguishable from current', () => {
  const decisions = [
    decision({ id: 'live', text: 'use postgres', createdAt: T }),
    decision({ id: 'dead', text: 'use sqlite', createdAt: T - 10_000, supersededBy: 'live' }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />);
  // Still present on the page (never deleted from the record)...
  expect(html).toContain('use sqlite');
  // ...but struck through and labeled, so it never reads as a live, currently-in-force decision.
  expect(html).toContain('line-through');
  expect(html).toContain('superseded');
});

test('a small history renders inline; a large one collapses behind a disclosure, still reachable', () => {
  const small = [
    decision({ id: 'live', text: 'live one', createdAt: T }),
    decision({ id: 's1', text: 'first superseded', createdAt: T - 1000, supersededBy: 'live' }),
  ];
  const htmlSmall = renderToStaticMarkup(<DecisionsPanel decisions={small} criteria={[]} now={T} />);
  expect(htmlSmall).toContain('first superseded');
  expect(htmlSmall).not.toContain('show 1 superseded');

  const large = [
    decision({ id: 'live', text: 'live one', createdAt: T }),
    ...Array.from({ length: 4 }, (_, i) => decision({ id: `s${i}`, text: `superseded ${i}`, createdAt: T - i, supersededBy: 'live' })),
  ];
  const htmlLarge = renderToStaticMarkup(<DecisionsPanel decisions={large} criteria={[]} now={T} />);
  // Collapsed by default: the disclosure control is present, but the superseded TEXT is not rendered
  // until it is opened — never hidden outright (it is one click away), never dumped inline either.
  expect(htmlLarge).toContain('show 4 superseded decisions');
  expect(htmlLarge).not.toContain('superseded 0');
});

test('a model-delta decision shows its evidence anchors', () => {
  const decisions = [
    decision({
      id: 'md1',
      text: 'switched to a queue-based retry',
      source: 'model-delta',
      createdAt: T,
      evidence: ['src/worker.ts:10-20', 'src/queue.ts'],
    }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />);
  expect(html).toContain('model delta');
  expect(html).toContain('src/worker.ts:10-20');
  expect(html).toContain('src/queue.ts');
});

test('a decision with no source reads as "recorded", not a fabricated one', () => {
  const html = renderToStaticMarkup(<DecisionsPanel decisions={[decision({ createdAt: T })]} criteria={[]} now={T} />);
  expect(html).toContain('recorded');
});

test('renders acceptance criteria with their completed state and an honest empty state', () => {
  const emptyHtml = renderToStaticMarkup(<DecisionsPanel decisions={[]} criteria={[]} now={T} />);
  expect(emptyHtml).toContain('ACCEPTANCE CRITERIA');
  expect(emptyHtml).toContain('absence');

  const criteria = [
    criterion({ id: 'a', text: 'endpoint returns 200', completed: true }),
    criterion({ id: 'b', text: 'errors are logged', completed: false }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={[]} criteria={criteria} now={T} />);
  expect(html).toContain('endpoint returns 200');
  expect(html).toContain('errors are logged');
  expect(html).toContain('1 of 2 met');
});
