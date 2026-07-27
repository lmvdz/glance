import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanProse } from './PlanProse';

test('steps keep their numbers as real text, because that is what you say when you answer', () => {
  // "do 2 and 4, skip 3" only works if 2, 3 and 4 are on the screen and selectable.
  const html = renderToStaticMarkup(<PlanProse markdown={'1. first thing\n2. second thing\n3. third thing\n'} />);
  expect(html).toContain('>1<');
  expect(html).toContain('>2<');
  expect(html).toContain('>3<');
  expect(html).toContain('first thing');
});

test('a numbered list that starts at 4 is not renumbered to 1', () => {
  const html = renderToStaticMarkup(<PlanProse markdown={'4. the fourth step\n5. the fifth\n'} />);
  expect(html).toContain('>4<');
  expect(html).toContain('>5<');
  expect(html).not.toContain('>1<');
});

test('nested steps read as 2.1, not as a restarted list', () => {
  const html = renderToStaticMarkup(<PlanProse markdown={'1. outer\n2. second\n   1. inner\n'} />);
  expect(html).toContain('2.1');
});

test('inline identifiers stay mono — a plan names files and flags, and those are addresses', () => {
  const html = renderToStaticMarkup(<PlanProse markdown={'touch `src/server.ts` only'} />);
  expect(html).toContain('JetBrains Mono');
  expect(html).toContain('src/server.ts');
});

test('a table renders as a table rather than as pipes', () => {
  const html = renderToStaticMarkup(<PlanProse markdown={'| a | b |\n|---|---|\n| 1 | 2 |\n'} />);
  expect(html).toContain('<table');
  expect(html).not.toContain('|---|');
});

test('prose is capped to a reading measure rather than filling the rail', () => {
  expect(renderToStaticMarkup(<PlanProse markdown={'hello'} measure={54} />)).toContain('54ch');
});
