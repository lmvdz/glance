import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Kbd } from './Kbd';
import { MonoLabel } from './MonoLabel';
import { PanelSection } from './PanelSection';
import { DiffStat } from './DiffStat';

test('Kbd renders the key and an optional trailing label', () => {
  expect(renderToStaticMarkup(<Kbd keys="N" />)).toContain('>N<');
  const withLabel = renderToStaticMarkup(<Kbd keys="]" label="next tab" />);
  expect(withLabel).toContain('>]<');
  expect(withLabel).toContain('next tab');
});

test('MonoLabel renders its children uppercase-styled', () => {
  expect(renderToStaticMarkup(<MonoLabel>Roster</MonoLabel>)).toContain('Roster');
});

test('PanelSection renders a title, optional right slot, and its body', () => {
  const html = renderToStaticMarkup(
    <PanelSection title="Land" right="3">
      <div>body content</div>
    </PanelSection>,
  );
  expect(html).toContain('Land');
  expect(html).toContain('>3<');
  expect(html).toContain('body content');
});

test('PanelSection omits the right slot when not given', () => {
  const html = renderToStaticMarkup(<PanelSection title="Land"><div /></PanelSection>);
  expect(html).toContain('Land');
});

test('DiffStat renders both signs when both are non-zero', () => {
  const html = renderToStaticMarkup(<DiffStat added={312} removed={332} />);
  expect(html).toContain('+312');
  expect(html).toContain('-332');
});

test('DiffStat omits a zero side', () => {
  const html = renderToStaticMarkup(<DiffStat added={5} removed={0} />);
  expect(html).toContain('+5');
  expect(html).not.toContain('>-0<');
});

test('DiffStat renders an em dash placeholder when there are no changes at all', () => {
  const html = renderToStaticMarkup(<DiffStat added={0} removed={0} />);
  expect(html).toContain('—');
});
