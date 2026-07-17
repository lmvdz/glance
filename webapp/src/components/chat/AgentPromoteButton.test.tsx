/**
 * AgentPromoteButton + the promoted "unit" pill (daily-onramp 06): the affordance renders ONLY
 * for an un-promoted console chat, and the SAME thread's meta bar flips to unit chrome once the
 * roster echoes `promoted:true` — the re-render half of the concern's Verify, exercised as the
 * two static states either side of the flip (the flip itself is just the roster prop changing).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentMetaBar, AgentPromoteButton } from './AgentMetaBar';
import type { AgentDTO } from '../../lib/dto';

const consoleChat = (over: Partial<AgentDTO> = {}): AgentDTO => ({
  id: 'chat-1',
  name: 'chat',
  kind: 'omp-operator',
  status: 'idle',
  repo: '/srv/r',
  worktree: '/srv/r/wt',
  pending: [],
  lastActivity: 1,
  autonomyMode: 'assist',
  effectiveMode: 'assist',
  verificationState: 'unknown',
  availableActions: [],
  ...over,
});

describe('AgentPromoteButton', () => {
  test('renders "Make this a unit" for an un-promoted console chat', () => {
    const html = renderToStaticMarkup(<AgentPromoteButton agent={consoleChat()} showToast={() => {}} />);
    expect(html).toContain('Make this a unit');
    expect(html).not.toContain('disabled=""');
  });

  test('renders NOTHING once the agent is promoted — the button never lingers after the flip', () => {
    expect(renderToStaticMarkup(<AgentPromoteButton agent={consoleChat({ promoted: true })} showToast={() => {}} />)).toBe('');
  });

  test('renders NOTHING for a regular working unit or no agent — no button that always 409s', () => {
    expect(renderToStaticMarkup(<AgentPromoteButton agent={consoleChat({ name: 'builder' })} showToast={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<AgentPromoteButton agent={undefined} showToast={() => {}} />)).toBe('');
  });
});

describe('AgentMetaBar unit chrome', () => {
  test('a promoted chat shows the "unit" pill; an un-promoted one does not', () => {
    const promoted = renderToStaticMarkup(<AgentMetaBar agent={consoleChat({ promoted: true })} changedFiles={0} />);
    expect(promoted).toContain('>unit<');
    expect(promoted).toContain('now a working unit');

    const plain = renderToStaticMarkup(<AgentMetaBar agent={consoleChat()} changedFiles={0} />);
    expect(plain).not.toContain('>unit<');
  });
});
