import { afterEach, describe, expect, test } from 'bun:test';
import { appendModelMessage, appendUserMessage, loadPersistedSessionsOrNull, mergeSessions, normalizeAssistantSessions, updateSessionAgentId, type Session } from './sessionStore';

function session(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return { title: overrides.id, messages: [], updatedAt: 0, ...overrides };
}

describe('normalizeAssistantSessions', () => {
  test('falls back to a fresh initial session for non-array/garbage input', () => {
    expect(normalizeAssistantSessions(null).length).toBe(1);
    expect(normalizeAssistantSessions('not an array').length).toBe(1);
    expect(normalizeAssistantSessions({}).length).toBe(1);
  });

  test('sorts newest-updated first', () => {
    const sessions = normalizeAssistantSessions([session({ id: 'old', updatedAt: 1 }), session({ id: 'new', updatedAt: 2 })]);
    expect(sessions.map((s) => s.id)).toEqual(['new', 'old']);
  });

  test('drops malformed entries but keeps well-formed siblings', () => {
    const sessions = normalizeAssistantSessions([{ id: 'ok', title: 'Ok', messages: [], updatedAt: 5 }, { garbage: true }]);
    expect(sessions.map((s) => s.id)).toEqual(['ok']);
  });
});

describe('appendModelMessage', () => {
  test('appends a durable model message to the matching session and bumps updatedAt', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 }), session({ id: 'b', updatedAt: 1 })];
    const next = appendModelMessage(sessions, 'a', 'finished the fix', 42);
    const target = next.find((s) => s.id === 'a')!;
    expect(target.messages).toEqual([{ role: 'model', text: 'finished the fix', timestamp: 42 }]);
    expect(target.updatedAt).toBe(42);
    expect(next.find((s) => s.id === 'b')).toBe(sessions[1]); // untouched sibling — same reference
  });

  test('returns the SAME array reference when the session id is not found', () => {
    const sessions = [session({ id: 'a' })];
    expect(appendModelMessage(sessions, 'missing', 'text', 1)).toBe(sessions);
  });

  test('returns the SAME array reference for blank/whitespace-only text (nothing worth persisting)', () => {
    const sessions = [session({ id: 'a' })];
    expect(appendModelMessage(sessions, 'a', '   ', 1)).toBe(sessions);
  });
});

describe('updateSessionAgentId', () => {
  test('patches metadata.agentId on the matching session', () => {
    const sessions = [session({ id: 'a', metadata: { status: 'active' } })];
    const next = updateSessionAgentId(sessions, 'a', 'agent-1');
    expect(next[0].metadata).toEqual({ status: 'active', agentId: 'agent-1' });
  });

  test('is a no-op (same reference) when the agentId is already set to this value', () => {
    const sessions = [session({ id: 'a', metadata: { agentId: 'agent-1' } })];
    expect(updateSessionAgentId(sessions, 'a', 'agent-1')).toBe(sessions);
  });

  // MEDIUM-3: bumps updatedAt on a real binding change — otherwise mergeSessions' tie-break (keeps
  // CURRENT's copy on an equal updatedAt) drops the voice bootstrap binding the next time an
  // external/persisted snapshot ties with it.
  test('bumps updatedAt to the given "now" on a real change', () => {
    const sessions = [session({ id: 'a', updatedAt: 5, metadata: { status: 'active' } })];
    const next = updateSessionAgentId(sessions, 'a', 'agent-1', 99);
    expect(next[0].updatedAt).toBe(99);
  });

  test('does NOT bump updatedAt when it is a no-op (already this agentId)', () => {
    const sessions = [session({ id: 'a', updatedAt: 5, metadata: { agentId: 'agent-1' } })];
    const next = updateSessionAgentId(sessions, 'a', 'agent-1', 99);
    expect(next[0].updatedAt).toBe(5);
  });
});

describe('appendUserMessage', () => {
  test('appends a durable user message stamped with the dispatch clientTurnId and bumps updatedAt', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 })];
    const next = appendUserMessage(sessions, 'a', 'fix the flaky test', 'voice:123', 42);
    expect(next[0].messages).toEqual([{ role: 'user', text: 'fix the flaky test', timestamp: 42, clientTurnId: 'voice:123' }]);
    expect(next[0].updatedAt).toBe(42);
  });

  test('returns the SAME array reference when the session id is not found', () => {
    const sessions = [session({ id: 'a' })];
    expect(appendUserMessage(sessions, 'missing', 'text', 'turn-1', 1)).toBe(sessions);
  });

  test('returns the SAME array reference for blank/whitespace-only text', () => {
    const sessions = [session({ id: 'a' })];
    expect(appendUserMessage(sessions, 'a', '   ', 'turn-1', 1)).toBe(sessions);
  });
});

// MEDIUM-3's binding fix, end to end: mergeSessions now actually adopts a voice binding write.
describe('MEDIUM-3: mergeSessions adopts a fresh updateSessionAgentId binding write', () => {
  test('a persisted binding write (fresh updatedAt) wins the merge over a stale current copy with no agentId', () => {
    const current = [session({ id: 'a', updatedAt: 5 })]; // pre-binding — no agentId yet
    const persisted = updateSessionAgentId(current, 'a', 'agent-9', 6); // the voice bootstrap bind
    const merged = mergeSessions(current, persisted);
    expect(merged[0].metadata?.agentId).toBe('agent-9');
  });
});

describe('mergeSessions', () => {
  test('adopts a persisted session current does not have', () => {
    const current = [session({ id: 'a', updatedAt: 1 })];
    const persisted = [session({ id: 'a', updatedAt: 1 }), session({ id: 'b', updatedAt: 2 })];
    const merged = mergeSessions(current, persisted);
    expect(merged.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  test('a strictly newer persisted copy wins', () => {
    const current = [session({ id: 'a', updatedAt: 1, title: 'stale' })];
    const persisted = [session({ id: 'a', updatedAt: 2, title: 'fresh' })];
    const merged = mergeSessions(current, persisted);
    expect(merged[0].title).toBe('fresh');
  });

  test('a tie (same updatedAt) keeps CURRENT\'s own copy, not persisted', () => {
    const current = [session({ id: 'a', updatedAt: 5, title: 'mine' })];
    const persisted = [session({ id: 'a', updatedAt: 5, title: 'theirs' })];
    const merged = mergeSessions(current, persisted);
    expect(merged[0].title).toBe('mine');
  });

  test('returns the SAME array reference when nothing changed — the self-notify loop guard', () => {
    const current = [session({ id: 'a', updatedAt: 5 })];
    const persisted = [session({ id: 'a', updatedAt: 5 })]; // an echo of current's own write
    expect(mergeSessions(current, persisted)).toBe(current);
  });
});

// LOW-7: loadPersistedSessionsOrNull distinguishes a storage/parse FAILURE (null) from a
// genuinely empty/missing blob (still normalizes to a default session, same as
// loadPersistedSessions) — VoiceCallContext's deletion watch needs this so a mid-call storage
// hiccup is never misread as "the bound session was deleted".
describe('loadPersistedSessionsOrNull', () => {
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  test('returns null when localStorage.getItem throws (e.g. private-mode storage block)', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => { throw new Error('storage blocked'); } } },
    });
    expect(loadPersistedSessionsOrNull()).toBeNull();
  });

  test('returns null on corrupt JSON — a genuine parse failure, not "no sessions"', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => '{not valid json' } },
    });
    expect(loadPersistedSessionsOrNull()).toBeNull();
  });

  test('returns a normalized default session (NOT null) for a genuinely missing blob', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => null } },
    });
    const result = loadPersistedSessionsOrNull();
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  test('returns the real parsed sessions when storage reads cleanly', () => {
    const stored = JSON.stringify([{ id: 'a', title: 'A', messages: [], updatedAt: 3 }]);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => stored } },
    });
    expect(loadPersistedSessionsOrNull()?.map((s) => s.id)).toEqual(['a']);
  });
});
