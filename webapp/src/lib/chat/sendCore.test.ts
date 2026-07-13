import { expect, test } from 'bun:test';
import { buildPromptCommand, ensureConsoleAgent, type SendCoreDeps } from './sendCore';
import type { AgentDTO } from '../dto';
import type { Task } from '../../types';

/** A minimal `SendCoreDeps` with an `apiJson` that records every call and resolves after a real
 *  microtask tick (`await Promise.resolve()`) — exercising the actual race window a synchronous
 *  stub would paper over. */
function makeDeps(overrides: Partial<SendCoreDeps> = {}): { deps: SendCoreDeps; calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const deps: SendCoreDeps = {
    apiJson: (async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      await Promise.resolve();
      return { agentId: 'agent-minted' };
    }) as SendCoreDeps['apiJson'],
    subscribeConsole: () => {},
    roster: [],
    currentProject: { id: 'repo-x' },
    selectedModel: '',
    ...overrides,
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// ensureConsoleAgent — single-flight mint
// ---------------------------------------------------------------------------

test('ensureConsoleAgent: two concurrent calls for the same session issue exactly one /api/console POST and both resolve to the same minted agent', async () => {
  const { deps, calls } = makeDeps();
  const subscribed: string[] = [];
  deps.subscribeConsole = (id) => subscribed.push(id);

  const [a, b] = await Promise.all([
    ensureConsoleAgent(deps, 'session-race'),
    ensureConsoleAgent(deps, 'session-race'),
  ]);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe('/api/console');
  expect(a).toBe('agent-minted');
  expect(b).toBe('agent-minted');
  // Post-mint subscribe (reconnect-safe registration, distinct from sendConsoleCommand) fires once.
  expect(subscribed).toEqual(['agent-minted']);
});

test('ensureConsoleAgent: a third caller that arrives mid-flight also joins the same in-flight mint', async () => {
  const { deps, calls } = makeDeps();
  const p1 = ensureConsoleAgent(deps, 'session-race-3');
  const p2 = ensureConsoleAgent(deps, 'session-race-3');
  const p3 = ensureConsoleAgent(deps, 'session-race-3');

  const results = await Promise.all([p1, p2, p3]);
  expect(calls).toHaveLength(1);
  expect(results).toEqual(['agent-minted', 'agent-minted', 'agent-minted']);
});

test('ensureConsoleAgent: returns the current agent id immediately, without minting, when it is still live in the roster', async () => {
  const { deps, calls } = makeDeps({ roster: [{ id: 'agent-live' } as AgentDTO] });
  const result = await ensureConsoleAgent(deps, 'session-live', 'agent-live');
  expect(result).toBe('agent-live');
  expect(calls).toHaveLength(0);
});

test('ensureConsoleAgent: re-mints when the current agent id is no longer in the roster (evicted/killed/restarted away)', async () => {
  const { deps, calls } = makeDeps({ roster: [{ id: 'some-other-agent' } as AgentDTO] });
  const result = await ensureConsoleAgent(deps, 'session-stale', 'agent-dead');
  expect(result).toBe('agent-minted');
  expect(calls).toHaveLength(1);
});

test('ensureConsoleAgent: clears its single-flight cache once the mint settles, so a later independent send mints again', async () => {
  const { deps, calls } = makeDeps();
  await ensureConsoleAgent(deps, 'session-repeat');
  await ensureConsoleAgent(deps, 'session-repeat');
  expect(calls).toHaveLength(2);
});

test('ensureConsoleAgent: a mint failure rejects every concurrent caller exactly once and still clears the cache for a retry', async () => {
  let callCount = 0;
  const deps: SendCoreDeps = {
    apiJson: (async () => {
      callCount += 1;
      if (callCount === 1) {
        await Promise.resolve();
        throw new Error('mint failed');
      }
      return { agentId: 'agent-retry' };
    }) as SendCoreDeps['apiJson'],
    subscribeConsole: () => {},
    roster: [],
    currentProject: null,
    selectedModel: '',
  };

  const [first, second] = await Promise.allSettled([
    ensureConsoleAgent(deps, 'session-fail'),
    ensureConsoleAgent(deps, 'session-fail'),
  ]);
  expect(callCount).toBe(1);
  expect(first.status).toBe('rejected');
  expect(second.status).toBe('rejected');

  const retried = await ensureConsoleAgent(deps, 'session-fail');
  expect(retried).toBe('agent-retry');
  expect(callCount).toBe(2);
});

test('ensureConsoleAgent: passes repo + the operator-selected model through to the mint POST body, never dropping the model choice', async () => {
  const { deps, calls } = makeDeps({ currentProject: { id: 'repo-y' }, selectedModel: 'openai/gpt-5.5' });
  await ensureConsoleAgent(deps, 'session-model');
  const body = JSON.parse((calls[0]?.[1]?.body as string) ?? '{}');
  expect(body).toEqual({ repo: 'repo-y', model: 'openai/gpt-5.5' });
});

test('ensureConsoleAgent: a malformed mint response with no agentId rejects instead of flowing undefined into subscribe', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const subscribed: string[] = [];
  const deps: SendCoreDeps = {
    apiJson: (async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      await Promise.resolve();
      return {} as any; // malformed: server responded but omitted agentId
    }) as SendCoreDeps['apiJson'],
    subscribeConsole: (id) => subscribed.push(id),
    roster: [],
    currentProject: { id: 'repo-x' },
    selectedModel: '',
  };

  await expect(ensureConsoleAgent(deps, 'session-malformed')).rejects.toThrow('/api/console returned no agentId');
  expect(subscribed).toEqual([]);
  expect(calls).toHaveLength(1);
});

test('ensureConsoleAgent: throws synchronously when sessionId is empty', () => {
  const { deps } = makeDeps();
  expect(() => ensureConsoleAgent(deps, '')).toThrow('sessionId required');
});

test('ensureConsoleAgent: after a mint resolves, a call with the new id but a roster that has not yet caught up does not re-mint (closes the mint-resolve/roster-broadcast race)', async () => {
  const { deps, calls } = makeDeps({ roster: [] });
  const mintedId = await ensureConsoleAgent(deps, 'session-race-window');
  expect(mintedId).toBe('agent-minted');
  expect(calls).toHaveLength(1);

  // Roster still hasn't caught up (still empty) — a caller re-checking liveness with the
  // freshly-minted id must trust the cached resolution rather than mint a second, orphaned agent.
  const result = await ensureConsoleAgent(deps, 'session-race-window', mintedId);
  expect(result).toBe(mintedId);
  expect(calls).toHaveLength(1);
});

test('ensureConsoleAgent: two different sessions minting concurrently issue exactly 2 POSTs, in parallel rather than one waiting on the other', async () => {
  const { deps, calls } = makeDeps();

  const pA = ensureConsoleAgent(deps, 'session-parallel-a');
  const pB = ensureConsoleAgent(deps, 'session-parallel-b');
  // Both POSTs fire synchronously (before either mint promise has settled) — proof session-b's
  // mint isn't waiting behind session-a's.
  expect(calls).toHaveLength(2);

  const [a, b] = await Promise.all([pA, pB]);
  expect(a).toBe('agent-minted');
  expect(b).toBe('agent-minted');
});

// ---------------------------------------------------------------------------
// buildPromptCommand — prompt-shape assembly
// ---------------------------------------------------------------------------

test('buildPromptCommand builds a fenced fleet/activity context block, defaulting displayText to textToSend', () => {
  const command = buildPromptCommand(
    { agentId: 'agent-1', agents: [], features: [], audit: [], pageContext: null },
    'what is happening',
    { clientTurnId: 'turn-1', source: 'composer' },
  ) as any;

  expect(command).toMatchObject({ type: 'prompt', id: 'agent-1', displayText: 'what is happening', clientTurnId: 'turn-1', source: 'composer' });
  expect(command.message).toContain('what is happening');
  expect(command.message).toContain('[Live context for reference — only act on it if asked]');
});

test('buildPromptCommand: opts.displayText can diverge from the message actually sent (the voice-caption case)', () => {
  const command = buildPromptCommand(
    { agentId: 'agent-1', agents: [], features: [], audit: [], pageContext: null },
    'the full context-augmented text sent to the agent',
    { displayText: 'hey, what is up' },
  ) as any;

  expect(command.displayText).toBe('hey, what is up');
  expect(command.message).toContain('the full context-augmented text sent to the agent');
});

test('buildPromptCommand folds in the selected task context when one is present', () => {
  const selectedTask = { id: 'task-1', title: 'Fix the bug', description: 'root cause is X' } as Task;
  const command = buildPromptCommand(
    { agentId: 'agent-1', agents: [], features: [], audit: [], selectedTask, pageContext: null },
    'ping',
    {},
  ) as any;

  expect(command.message).toContain('Current feature context:');
  expect(command.message).toContain('task-1 — Fix the bug');
  expect(command.message).toContain('root cause is X');
});

test('buildPromptCommand omits source/clientTurnId when opts does not carry them, rather than fabricating a value', () => {
  const command = buildPromptCommand(
    { agentId: 'agent-1', agents: [], features: [], audit: [], pageContext: null },
    'ping',
  ) as any;

  expect(command.source).toBeUndefined();
  expect(command.clientTurnId).toBeUndefined();
  expect(command.displayText).toBe('ping');
});
