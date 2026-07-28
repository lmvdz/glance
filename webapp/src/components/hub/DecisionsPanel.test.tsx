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

test('a small history renders inline with no disclosure at all', () => {
  const small = [
    decision({ id: 'live', text: 'live one', createdAt: T }),
    decision({ id: 's1', text: 'first superseded', createdAt: T - 1000, supersededBy: 'live' }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={small} criteria={[]} now={T} />);
  expect(html).toContain('first superseded');
  expect(html).not.toContain('superseded decision');
});

// Blind-review defect: the first cut gated superseded rows behind `{open ? rows : null}`, a real
// `useState` toggle — closed, those rows were absent from the tree entirely, not merely styled as
// hidden. "Superseded stays on the page, struck, never deleted" was false the instant the panel
// rendered collapsed: find-in-page and a screen reader could not reach it either. The fix swaps the
// button+state for a native <details>/<summary> — its children are always part of the document; only
// `open` (a plain boolean attribute, not a re-render) changes what CSS shows. These three tests pin
// that a large history is (a) collapsed by default, (b) its disclosure control is present, and
// (c) — the part that was wrong — every superseded decision's text is ALREADY in the rendered markup,
// not something a click has to fetch or mount.
test('a large history collapses behind a native <details> disclosure, closed by default', () => {
  const large = [
    decision({ id: 'live', text: 'live one', createdAt: T }),
    ...Array.from({ length: 4 }, (_, i) => decision({ id: `s${i}`, text: `superseded ${i}`, createdAt: T - i, supersededBy: 'live' })),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={large} criteria={[]} now={T} />);
  expect(html).toContain('4 superseded decisions');
  const detailsTag = html.match(/<details[^>]*>/)?.[0] ?? '';
  expect(detailsTag).not.toContain('open');
});

test('every superseded decision is present in the markup even while the disclosure is collapsed', () => {
  const large = [
    decision({ id: 'live', text: 'live one', createdAt: T }),
    ...Array.from({ length: 4 }, (_, i) => decision({ id: `s${i}`, text: `superseded ${i}`, createdAt: T - i, supersededBy: 'live' })),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={large} criteria={[]} now={T} />);
  for (let i = 0; i < 4; i++) expect(html).toContain(`superseded ${i}`);
});

test('a current decision renders with no strikethrough at all — the positive half of "historical is struck, current is not"', () => {
  const decisions = [decision({ id: 'live', text: 'use postgres', createdAt: T })];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />);
  expect(html).toContain('use postgres');
  expect(html).not.toContain('line-through');
});

// Invariant I2 at the render level: nothing seeded is dropped or duplicated on the page, whether it
// lands in the current ledger or the (possibly collapsed) history.
test('every seeded decision appears exactly once in the rendered markup, current or historical', () => {
  const decisions = [
    decision({ id: 'a', text: 'decision alpha text', createdAt: 5 }),
    decision({ id: 'b', text: 'decision bravo text', createdAt: 4, supersededBy: 'a' }),
    decision({ id: 'c', text: 'decision charlie text', createdAt: 3, supersededBy: 'a' }),
    decision({ id: 'd', text: 'decision delta text', createdAt: 2, supersededBy: 'a' }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />);
  for (const d of decisions) {
    const occurrences = html.split(d.text).length - 1;
    expect(occurrences).toBe(1);
  }
});

test('a dangling or self-referential supersededBy renders without throwing and without losing the decision', () => {
  const decisions = [
    decision({ id: 'orphan', text: 'dangling pointer decision', supersededBy: 'ghost-id-not-on-this-feature', createdAt: 1 }),
    decision({ id: 'self-ref', text: 'self referential decision', supersededBy: 'self-ref', createdAt: 2 }),
  ];
  expect(() => renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />)).not.toThrow();
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} />);
  expect(html).toContain('dangling pointer decision');
  expect(html).toContain('self referential decision');
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

// The supersede action — the only path to "correcting" a decision. Recording a replacement is the
// only way to change one; there is no edit or delete anywhere on this panel.
const AFFORDANCE_TEXT = 'supersede this decision';

test('a "supersede" affordance appears on every current decision', () => {
  const decisions = [
    decision({ id: 'live-1', text: 'use postgres', createdAt: T }),
    decision({ id: 'live-2', text: 'use redis for cache', createdAt: T - 500 }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} featureId="f1" />);
  // Exactly one affordance per current decision — never merged into one, never missing from one.
  expect(html.split(AFFORDANCE_TEXT).length - 1).toBe(2);
});

test('the "supersede" affordance never appears on a superseded (historical) decision', () => {
  const decisions = [
    decision({ id: 'dead-1', text: 'use sqlite', createdAt: T - 10_000, supersededBy: 'ghost-1' }),
    decision({ id: 'dead-2', text: 'use mongo', createdAt: T - 20_000, supersededBy: 'ghost-2' }),
  ];
  // Both decisions are historical — current is empty, so there is nothing left to supersede.
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} featureId="f1" />);
  expect(html).toContain('use sqlite');
  expect(html).toContain('use mongo');
  expect(html).not.toContain(AFFORDANCE_TEXT);
});

test('a mixed ledger offers the affordance only on the current decision, not its superseded predecessor', () => {
  const decisions = [
    decision({ id: 'live', text: 'use postgres', createdAt: T }),
    decision({ id: 'dead', text: 'use sqlite', createdAt: T - 10_000, supersededBy: 'live' }),
  ];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={[]} now={T} featureId="f1" />);
  expect(html.split(AFFORDANCE_TEXT).length - 1).toBe(1);
});

test('a successful supersede is reflected once the ledger is refreshed: the replacement reads current, the original reads struck-through history', () => {
  // Modeling BEFORE/AFTER a successful POST /api/features/:id/decisions/supersede — this panel
  // never mutates its own props, it only ever re-renders from what the reload hands back, so
  // "success" at the render layer means: given the server's post-write ledger, the split is right.
  const before = [decision({ id: 'old', text: 'use sqlite', source: 'human', createdAt: T - 10_000 })];
  const beforeHtml = renderToStaticMarkup(<DecisionsPanel decisions={before} criteria={[]} now={T} featureId="f1" />);
  expect(beforeHtml).toContain('use sqlite');
  expect(beforeHtml).not.toContain('line-through');
  expect(beforeHtml).toContain('1 current');

  const after = [
    decision({ id: 'new', text: 'use postgres', source: 'human', createdAt: T, supersedes: 'old' }),
    decision({ id: 'old', text: 'use sqlite', source: 'human', createdAt: T - 10_000, supersededBy: 'new' }),
  ];
  const afterHtml = renderToStaticMarkup(<DecisionsPanel decisions={after} criteria={[]} now={T} featureId="f1" />);
  expect(afterHtml).toContain('use postgres');
  expect(afterHtml).toContain('1 current');
  // The old decision is still on the page — never deleted — but now struck through and labeled.
  expect(afterHtml).toContain('use sqlite');
  expect(afterHtml).toContain('line-through');
  expect(afterHtml).toContain('superseded');
  // And it no longer offers to be superseded again — only the new current decision does.
  expect(afterHtml.split(AFFORDANCE_TEXT).length - 1).toBe(1);
});

test('no edit or delete affordance exists anywhere on the panel, for a current or a superseded decision', () => {
  const decisions = [
    decision({ id: 'live', text: 'use postgres', createdAt: T }),
    decision({ id: 'dead', text: 'use sqlite', createdAt: T - 10_000, supersededBy: 'live' }),
  ];
  const criteria = [criterion({ id: 'a', text: 'endpoint returns 200', completed: true })];
  const html = renderToStaticMarkup(<DecisionsPanel decisions={decisions} criteria={criteria} now={T} featureId="f1" />);
  expect(html).not.toMatch(/\bedit\b/i);
  expect(html).not.toMatch(/\bdelete\b/i);
  expect(html).not.toMatch(/\bremove\b/i);
});
