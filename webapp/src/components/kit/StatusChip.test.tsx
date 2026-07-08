import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusChip } from './StatusChip';

test('maps glance AgentStatus values to the reference labels', () => {
  expect(renderToStaticMarkup(<StatusChip status="working" />)).toContain('RUNNING');
  expect(renderToStaticMarkup(<StatusChip status="idle" />)).toContain('IDLE');
  expect(renderToStaticMarkup(<StatusChip status="error" />)).toContain('ERROR');
  expect(renderToStaticMarkup(<StatusChip status="stopped" />)).toContain('DONE');
  expect(renderToStaticMarkup(<StatusChip status="input" />)).toContain('NEEDS YOU');
});

test('is case-insensitive on the status key', () => {
  expect(renderToStaticMarkup(<StatusChip status="WORKING" />)).toContain('RUNNING');
});

test('renders an unknown/arbitrary label verbatim (uppercased), not silently as a known status', () => {
  const html = renderToStaticMarkup(<StatusChip status="Ready to merge" />);
  expect(html).toContain('READY TO MERGE');
});

test('an explicit variant overrides the status default variant', () => {
  const solid = renderToStaticMarkup(<StatusChip status="working" variant="outline" />);
  // outline uses a border color class, not the solid ember fill class
  expect(solid).toContain('border-[color:var(--wf-accent)]');
  expect(solid).not.toContain('bg-[color:var(--wf-accent)] text-black');
});

test('ERROR renders with the danger tone class', () => {
  const html = renderToStaticMarkup(<StatusChip status="error" />);
  expect(html).toContain('bg-red-100');
});

test("human tone renders the cool blue ramp (the references' pink role)", () => {
  // Mapped status…
  expect(renderToStaticMarkup(<StatusChip status="human" />)).toContain('bg-blue-100');
  // …and as a tone override on an arbitrary label (author-name chips).
  const named = renderToStaticMarkup(<StatusChip status="Sarah" tone="human" />);
  expect(named).toContain('SARAH');
  expect(named).toContain('border-blue-300'); // unknown labels default to outline
});

test('success tone renders emerald (reference B resolved-check), distinct from ember', () => {
  const html = renderToStaticMarkup(<StatusChip status="resolved" />);
  expect(html).toContain('RESOLVED');
  expect(html).toContain('bg-emerald-100');
  expect(html).not.toContain('--wf-accent');
});

test('tone override beats the mapped tone for a known status', () => {
  const html = renderToStaticMarkup(<StatusChip status="done" tone="success" />);
  expect(html).toContain('bg-emerald-50'); // done keeps its dim variant, but in success green
  expect(html).not.toContain('--wf-accent');
});
