import { describe, expect, test } from 'bun:test';
import { deriveSessionType, sessionTypeTone } from './sessionType';

describe('deriveSessionType', () => {
  test('matches phase words in the agent name', () => {
    expect(deriveSessionType({ name: 'Research authentication patterns' })).toBe('Research');
    expect(deriveSessionType({ name: 'Design discussion: token refresh strategy' })).toBe('Design');
    expect(deriveSessionType({ name: 'Structure outline: middleware module' })).toBe('Structure');
    expect(deriveSessionType({ name: 'Implementation plan: JWT validator' })).toBe('Plan');
    expect(deriveSessionType({ name: 'Implement JWT validation middleware' })).toBe('Implementation');
    expect(deriveSessionType({ name: 'Verify build' })).toBe('Verify');
  });

  test('falls back to Session for untyped names — never guesses a specific phase', () => {
    expect(deriveSessionType({ name: 'chat' })).toBe('Session');
    expect(deriveSessionType({ name: 'fixup-worker-3' })).toBe('Session');
    expect(deriveSessionType({ name: '' })).toBe('Session');
    expect(deriveSessionType({})).toBe('Session');
  });

  test('prefers the live workflow node label over the static agent name', () => {
    const agent = {
      name: 'auth-middleware-refactor',
      workflowGraph: { version: 1 as const, name: 'research-plan-implement', nodes: [{ id: 'plan', kind: 'agent', label: 'Plan' }], edges: [], start: 'plan', exit: 'plan' },
      workflowState: { currentNode: 'plan', visits: {}, vars: {}, rollup: [] },
    };
    expect(deriveSessionType(agent)).toBe('Plan');
  });

  test('falls back to the name when the current node id has no matching graph node', () => {
    const agent = {
      name: 'Research prior art',
      workflowGraph: { version: 1 as const, name: 'wf', nodes: [{ id: 'other', kind: 'agent', label: 'Something else' }], edges: [], start: 'other', exit: 'other' },
      workflowState: { currentNode: 'missing', visits: {}, vars: {}, rollup: [] },
    };
    expect(deriveSessionType(agent)).toBe('Research');
  });
});

describe('sessionTypeTone', () => {
  test('every real phase is the agent-active tone; the untyped fallback is neutral', () => {
    expect(sessionTypeTone('Research')).toBe('agent');
    expect(sessionTypeTone('Implementation')).toBe('agent');
    expect(sessionTypeTone('Session')).toBe('neutral');
  });
});
