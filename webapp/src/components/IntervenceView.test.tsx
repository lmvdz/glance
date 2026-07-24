import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InterveneMissingAgentFallback } from './IntervenceView';

test('dead intervene target renders honest resolved/agent-gone fallback, not blank no-agent pane', () => {
  const html = renderToStaticMarkup(<InterveneMissingAgentFallback agentId="agent-gone" onBack={() => {}} />);

  expect(html).toContain('Resolved / agent gone');
  expect(html).toContain('agent-gone');
  expect(html).not.toContain('No agent selected to step into.');
});
