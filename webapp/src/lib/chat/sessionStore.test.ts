import { afterEach, describe, expect, test } from 'bun:test';
import {
  advanceVoiceDebriefCursor,
  appendModelMessage,
  appendSpawnedUnit,
  appendUserMessage,
  loadPersistedSessionsOrNull,
  mergeSessions,
  normalizeAssistantSessions,
  recordVoiceCallEnded,
  updateSessionAgentId,
  type Session,
} from './sessionStore';
import type { SpawnedUnitRecord } from '../spawnProposal';

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

  test('a plain voice turn (no dispatch behind it) persists WITHOUT a clientTurnId field — nothing to dedupe against', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 })];
    const next = appendUserMessage(sessions, 'a', 'what is the fleet doing?', undefined, 42);
    expect(next[0].messages).toEqual([{ role: 'user', text: 'what is the fleet doing?', timestamp: 42 }]);
    expect('clientTurnId' in next[0].messages[0]).toBe(false);
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

// Concern 04: the debrief lane's ts-cursor two-phase commit primitive.
describe('advanceVoiceDebriefCursor', () => {
  test('sets cursorTs on a session with no prior voiceDebrief metadata, and bumps updatedAt', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 })];
    const next = advanceVoiceDebriefCursor(sessions, 'a', 100, 42);
    expect(next[0].metadata?.voiceDebrief).toEqual({ cursorTs: 100 });
    expect(next[0].updatedAt).toBe(42);
  });

  test('advances a strictly newer cursorTs and bumps updatedAt', () => {
    const sessions = [session({ id: 'a', updatedAt: 1, metadata: { voiceDebrief: { cursorTs: 50 } } })];
    const next = advanceVoiceDebriefCursor(sessions, 'a', 100, 42);
    expect(next[0].metadata?.voiceDebrief?.cursorTs).toBe(100);
    expect(next[0].updatedAt).toBe(42);
  });

  test('NEVER moves the cursor backward — same array reference, no updatedAt bump', () => {
    const sessions = [session({ id: 'a', updatedAt: 1, metadata: { voiceDebrief: { cursorTs: 100 } } })];
    const next = advanceVoiceDebriefCursor(sessions, 'a', 50, 42);
    expect(next).toBe(sessions);
    expect(next[0].updatedAt).toBe(1);
  });

  test('an EQUAL cursorTs is also a no-op (same reference) — advancing means strictly forward', () => {
    const sessions = [session({ id: 'a', updatedAt: 1, metadata: { voiceDebrief: { cursorTs: 100 } } })];
    expect(advanceVoiceDebriefCursor(sessions, 'a', 100, 42)).toBe(sessions);
  });

  test('preserves an existing lastCallEndedAt when only cursorTs advances', () => {
    const sessions = [session({ id: 'a', metadata: { voiceDebrief: { cursorTs: 10, lastCallEndedAt: 5 } } })];
    const next = advanceVoiceDebriefCursor(sessions, 'a', 20, 42);
    expect(next[0].metadata?.voiceDebrief).toEqual({ cursorTs: 20, lastCallEndedAt: 5 });
  });

  test('returns the SAME array reference when the session id is not found', () => {
    const sessions = [session({ id: 'a' })];
    expect(advanceVoiceDebriefCursor(sessions, 'missing', 100, 1)).toBe(sessions);
  });

  test('an untouched sibling session keeps its own reference', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 }), session({ id: 'b', updatedAt: 1 })];
    const next = advanceVoiceDebriefCursor(sessions, 'a', 100, 42);
    expect(next.find((s) => s.id === 'b')).toBe(sessions[1]);
  });
});

describe('recordVoiceCallEnded', () => {
  test('stamps lastCallEndedAt and seeds a fresh cursorTs for a NEVER-debriefed session (no voiceDebrief at all)', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 })];
    const now = 1_000_000_000_000; // arbitrary wall-clock ms, far past 24h from epoch
    const next = recordVoiceCallEnded(sessions, 'a', now);
    expect(next[0].metadata?.voiceDebrief).toEqual({ cursorTs: now, lastCallEndedAt: now });
    expect(next[0].updatedAt).toBe(now);
  });

  test('stamps lastCallEndedAt WITHOUT touching an existing cursorTs', () => {
    const sessions = [session({ id: 'a', metadata: { voiceDebrief: { cursorTs: 50 } } })];
    const next = recordVoiceCallEnded(sessions, 'a', 999);
    expect(next[0].metadata?.voiceDebrief).toEqual({ cursorTs: 50, lastCallEndedAt: 999 });
  });

  test('always bumps updatedAt and always "changes" (returns a fresh array) for a found session', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 })];
    const next = recordVoiceCallEnded(sessions, 'a', 500);
    expect(next).not.toBe(sessions);
    expect(next[0].updatedAt).toBe(500);
  });

  test('returns the SAME array reference when the session id is not found', () => {
    const sessions = [session({ id: 'a' })];
    expect(recordVoiceCallEnded(sessions, 'missing', 500)).toBe(sessions);
  });

  test('repeated calls on a never-debriefed session only seed cursorTs once (the first call wins)', () => {
    const sessions = [session({ id: 'a' })];
    const first = recordVoiceCallEnded(sessions, 'a', 1_000);
    const second = recordVoiceCallEnded(first, 'a', 2_000);
    expect(second[0].metadata?.voiceDebrief).toEqual({ cursorTs: 1_000, lastCallEndedAt: 2_000 });
  });
});

describe('appendSpawnedUnit', () => {
  const record: SpawnedUnitRecord = { id: 'spawn:1', agentId: 'agent-9', createdAt: 42, prompt: 'build a widget' };

  test('appends a durable SpawnedUnitRecord to the matching session and bumps updatedAt', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 })];
    const next = appendSpawnedUnit(sessions, 'a', record, 99);
    expect(next[0].spawnedUnits).toEqual([record]);
    expect(next[0].updatedAt).toBe(99);
  });

  test('appends onto an existing spawnedUnits list without disturbing prior entries', () => {
    const existing: SpawnedUnitRecord = { id: 'spawn:0', agentId: 'agent-1', createdAt: 1, prompt: 'earlier task' };
    const sessions = [session({ id: 'a', spawnedUnits: [existing] })];
    const next = appendSpawnedUnit(sessions, 'a', record, 99);
    expect(next[0].spawnedUnits).toEqual([existing, record]);
  });

  test('returns the SAME array reference when the session id is not found', () => {
    const sessions = [session({ id: 'a' })];
    expect(appendSpawnedUnit(sessions, 'missing', record, 1)).toBe(sessions);
  });

  test('an untouched sibling session keeps its own reference', () => {
    const sessions = [session({ id: 'a', updatedAt: 1 }), session({ id: 'b', updatedAt: 1 })];
    const next = appendSpawnedUnit(sessions, 'a', record, 99);
    expect(next.find((s) => s.id === 'b')).toBe(sessions[1]);
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
