import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { sessionRowsFromAgents, TaskSessionsTable } from './TaskSessionsTable';
import type { AgentDTO } from '../lib/dto';

function agent(overrides: Partial<AgentDTO> & Pick<AgentDTO, 'id' | 'name'>): AgentDTO {
  return { status: 'idle', repo: '/tmp/repo', worktree: '/tmp/wt', pending: [], lastActivity: 1000, autonomyMode: 'assist', effectiveMode: 'assist', verificationState: 'unknown', availableActions: [], ...overrides };
}

describe('sessionRowsFromAgents', () => {
  test('projects agents into typed rows, newest activity first', () => {
    const rows = sessionRowsFromAgents([
      agent({ id: 'a1', name: 'Research prior art', lastActivity: 1000 }),
      agent({ id: 'a2', name: 'Implement JWT validation middleware', status: 'working', lastActivity: 5000 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a2', 'a1']);
    expect(rows[0].type).toBe('Implementation');
    expect(rows[1].type).toBe('Research');
  });

  test('untyped agent names fall back to the Session type, not a guess', () => {
    const rows = sessionRowsFromAgents([agent({ id: 'a1', name: 'chat' })]);
    expect(rows[0].type).toBe('Session');
  });
});

describe('TaskSessionsTable', () => {
  test('renders an empty state with no rows', () => {
    const html = renderToStaticMarkup(<TaskSessionsTable rows={[]} onOpenSession={() => {}} />);
    expect(html).toContain('No sessions yet');
  });

  test('renders one row per session with its status and type chip (kit vocabulary)', () => {
    const rows = sessionRowsFromAgents([agent({ id: 'a1', name: 'Design discussion: token refresh strategy', status: 'input', lastActivity: Date.now() })]);
    const html = renderToStaticMarkup(<TaskSessionsTable rows={rows} onOpenSession={() => {}} />);
    expect(html).toContain('Design discussion: token refresh strategy');
    // The kit StatusChip renders the KNOWN-map labels: input → NEEDS YOU; the free-text type
    // label renders verbatim uppercased.
    expect(html).toContain('>DESIGN<');
    expect(html).toContain('>NEEDS YOU<');
  });

  test('the untyped Session fallback chip renders muted, visually distinct from real types', () => {
    const rows = sessionRowsFromAgents([
      agent({ id: 'a1', name: 'chat' }), // untyped → neutral tone
      agent({ id: 'a2', name: 'Research prior art' }), // typed → ember tone
    ]);
    const html = renderToStaticMarkup(<TaskSessionsTable rows={rows} onOpenSession={() => {}} />);
    // neutral outline (gray) on the fallback; ember (accent var) on the real type
    expect(html).toMatch(/border-gray-300[^>]*>SESSION</);
    expect(html).toMatch(/var\(--wf-accent\)[^>]*>RESEARCH</);
  });
});
