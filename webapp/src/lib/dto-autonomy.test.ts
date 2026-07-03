import { expect, test } from 'bun:test';
import type { AgentDTO } from './dto';

test('AgentDTO carries canonical autonomy/proof fields', () => {
  const dto = {
    id: 'a1',
    name: 'agent',
    status: 'idle',
    repo: '/repo',
    worktree: '/repo/wt',
    pending: [],
    lastActivity: 1,
    autonomyMode: 'autodrive',
    effectiveMode: 'assist',
    verificationState: 'fresh',
    proof: { commit: 'abc', command: 'bun test', ranAt: 1, fingerprint: 'abc:bun test' },
    availableActions: ['set-mode', 'prompt', 'answer', 'interrupt', 'verify', 'land'],
  } satisfies AgentDTO;

  expect(dto.autonomyMode).toBe('autodrive');
  expect(dto.effectiveMode).toBe('assist');
  expect(dto.availableActions).toContain('land');
});
