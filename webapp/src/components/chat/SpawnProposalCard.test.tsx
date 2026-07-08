import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpawnProposalCard } from './SpawnProposalCard';

test('SpawnProposalCard: renders the propose affordance with its exact call-to-action label', () => {
  const html = renderToStaticMarkup(<SpawnProposalCard onPropose={() => {}} />);
  expect(html).toContain('Spawn a unit to build this.');
  expect(html).toContain('annotated capture');
});

test('SpawnProposalCard: marks itself with a stable test hook attribute', () => {
  const html = renderToStaticMarkup(<SpawnProposalCard onPropose={() => {}} />);
  expect(html).toContain('data-spawn-proposal-card');
});
