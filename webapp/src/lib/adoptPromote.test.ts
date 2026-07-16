/**
 * Promote/adopt bridge lib (daily-onramp 06) — the pure halves the two new surfaces stand on:
 * the promote-visibility gate, the presence→adopt-card derivation, and the request/response
 * plumbing (exact paths, exact bodies, verbatim `reason` on refusal).
 */
import { describe, expect, test } from 'bun:test';
import {
  adoptableSessions,
  adoptSession,
  isPromotableChat,
  parseAdhocLabel,
  promoteChat,
  type PresenceEntryDTO,
} from './adoptPromote';
import type { AgentDTO } from './dto';

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

// ── isPromotableChat: the wire-visible mirror of the server's promote gate ──────────────────────

describe('isPromotableChat', () => {
  test('a plain console chat unit is promotable', () => {
    expect(isPromotableChat(consoleChat())).toBe(true);
  });

  test('an already-promoted chat is NOT — the button disappears the moment the flag echoes back', () => {
    expect(isPromotableChat(consoleChat({ promoted: true }))).toBe(false);
  });

  test('regular working units, workflows, roles, and branches are never offered the button', () => {
    expect(isPromotableChat(consoleChat({ name: 'builder' }))).toBe(false);
    expect(isPromotableChat(consoleChat({ kind: 'workflow' }))).toBe(false);
    expect(isPromotableChat(consoleChat({ executionRole: 'observer' }))).toBe(false);
    expect(isPromotableChat(consoleChat({ workflow: { path: 'w.fabro' } }))).toBe(false);
    expect(isPromotableChat(consoleChat({ parentId: 'parent-1' }))).toBe(false);
    expect(isPromotableChat(undefined)).toBe(false);
    expect(isPromotableChat(null)).toBe(false);
  });
});

// ── presence → adopt cards ──────────────────────────────────────────────────────────────────────

const entry = (over: Partial<PresenceEntryDTO> = {}): PresenceEntryDTO => ({
  id: 'harness-abc123def456abc123def456',
  repo: '/home/u/proj',
  repoName: 'proj',
  operator: 'lars',
  agent: 'claude:sess-uuid-1',
  source: 'other',
  heartbeat: 1000,
  ...over,
});

describe('parseAdhocLabel', () => {
  test('splits at the FIRST colon — session ids may carry their own colons', () => {
    expect(parseAdhocLabel('claude:sess:with:colons')).toEqual({ harness: 'claude', sessionId: 'sess:with:colons' });
  });

  test('refuses labels without both halves', () => {
    expect(parseAdhocLabel('no-colon')).toBeNull();
    expect(parseAdhocLabel(':leading')).toBeNull();
    expect(parseAdhocLabel('trailing:')).toBeNull();
    expect(parseAdhocLabel('')).toBeNull();
  });
});

describe('adoptableSessions', () => {
  test('a harness-hook presence row becomes one card carrying exactly what adopt needs', () => {
    const cards = adoptableSessions([entry({ branch: 'main', startedAt: 500 })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      claimId: 'harness-abc123def456abc123def456',
      harness: 'claude',
      sessionId: 'sess-uuid-1',
      cwd: '/home/u/proj', // the registered root the hook claimed — adopt's cwd
      repoName: 'proj',
      branch: 'main',
      label: 'claude:sess-uuid-1',
    });
  });

  test('squad/omp agents and cockpit human-presence rows are never offered — guaranteed-409 dead ends', () => {
    expect(adoptableSessions([entry({ source: 'squad' })])).toHaveLength(0);
    expect(adoptableSessions([entry({ source: 'omp' })])).toHaveLength(0);
    // A cockpit row IS source "other" but has a server-minted (non harness-) claim id.
    expect(adoptableSessions([entry({ id: '1416092-mrlo12ud-g87r', agent: 'glance-cockpit:s1' })])).toHaveLength(0);
  });

  test('malformed labels and empty repos are dropped, not guessed at (fail closed)', () => {
    expect(adoptableSessions([entry({ agent: 'no-colon-label' })])).toHaveLength(0);
    expect(adoptableSessions([entry({ repo: '' })])).toHaveLength(0);
  });
});

// ── request/response plumbing (fake fetcher, no network) ────────────────────────────────────────

interface Captured {
  path: string;
  body: unknown;
}

function fakeFetcher(response: Response): { fetcher: (path: string, init?: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetcher: async (path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return response;
    },
  };
}

describe('promoteChat', () => {
  test('POSTs the exact route with a bare body and hands back the ok result (v1: no synthesized task)', async () => {
    const { fetcher, calls } = fakeFetcher(Response.json({ ok: true, agent: { id: 'chat-1', promoted: true } }));
    const result = await promoteChat('chat-1', undefined, fetcher);
    expect(calls).toEqual([{ path: '/api/agents/chat-1/promote', body: {} }]);
    expect(result.ok).toBe(true);
    expect(result.agent?.promoted).toBe(true);
  });

  test('an explicit task rides the body; the agent id is URI-encoded', async () => {
    const { fetcher, calls } = fakeFetcher(Response.json({ ok: true }));
    await promoteChat('chat/1', '  ship it  ', fetcher);
    expect(calls).toEqual([{ path: '/api/agents/chat%2F1/promote', body: { task: 'ship it' } }]);
  });

  test('a 409 refusal returns the server reason VERBATIM', async () => {
    const { fetcher } = fakeFetcher(Response.json({ ok: false, reason: 'not a promotable console chat unit' }, { status: 409 }));
    const result = await promoteChat('unit-1', undefined, fetcher);
    expect(result).toEqual({ ok: false, reason: 'not a promotable console chat unit' });
  });

  test('a non-JSON body (auth gate, proxy page) folds into an honest ok:false, never a throw', async () => {
    const { fetcher } = fakeFetcher(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }));
    const result = await promoteChat('chat-1', undefined, fetcher);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('401');
  });
});

describe('adoptSession', () => {
  test("POSTs /api/agents/adopt with exactly the presence entry's fields", async () => {
    const { fetcher, calls } = fakeFetcher(Response.json({ ok: true, agent: { id: 'u1', name: 'adopted-claude' } }));
    const [card] = adoptableSessions([entry()]);
    const result = await adoptSession(card, fetcher);
    expect(calls).toEqual([{ path: '/api/agents/adopt', body: { harness: 'claude', sessionId: 'sess-uuid-1', cwd: '/home/u/proj' } }]);
    expect(result.ok).toBe(true);
    expect(result.agent?.name).toBe('adopted-claude');
  });

  test('a 409 refusal returns the server reason VERBATIM for the card to surface', async () => {
    const { fetcher } = fakeFetcher(Response.json({ ok: false, reason: "this session's current state is already adopted" }, { status: 409 }));
    const result = await adoptSession({ harness: 'claude', sessionId: 's', cwd: '/r' }, fetcher);
    expect(result).toEqual({ ok: false, reason: "this session's current state is already adopted" });
  });
});
