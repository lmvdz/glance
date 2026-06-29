import { expect, test, describe } from 'bun:test';
import {
  fleetActivityLines,
  fleetActivityRollup,
  fleetActivityDigest,
  shortTarget,
} from './fleetActivity';
import type { AuditEntry, AgentDTO } from './dto';

function entry(action: string, extra: Partial<AuditEntry> = {}): AuditEntry {
  return { id: extra.id ?? 1, at: extra.at ?? 1000, actor: extra.actor ?? 'local', action, target: extra.target ?? null, outcome: extra.outcome ?? 'ok', detail: extra.detail };
}

function agent(id: string, name: string): AgentDTO {
  return { id, name, status: 'working', repo: '/r', worktree: '/w', pending: [], lastActivity: 0 } as AgentDTO;
}

// ───────────────────────────── shortTarget ─────────────────────────────

describe('shortTarget', () => {
  test('strips the generated id/hash tail, keeping the readable slug', () => {
    expect(shortTarget('ompsq-391-mqyq717u-t-5c67c880')).toBe('ompsq-391');
    expect(shortTarget('vpb-01-authoring-mqyi1tmy-5-f7dab73d')).toBe('vpb-01-authoring');
    expect(shortTarget('chat-mqw245g4-oa5a')).toBe('chat');
  });

  test('resolves a live agent name when the target is still in the roster', () => {
    const byId = new Map([['a1', agent('a1', 'tidy-fox')]]);
    expect(shortTarget('a1', byId)).toBe('tidy-fox');
  });

  test('null/empty target → "the fleet"', () => {
    expect(shortTarget(null)).toBe('the fleet');
    expect(shortTarget(undefined)).toBe('the fleet');
  });
});

// ───────────────────────────── fleetActivityRollup ─────────────────────────────

describe('fleetActivityRollup', () => {
  const now = 1_000_000;

  test('counts actions within the window and builds a headline', () => {
    const audit = [
      entry('land', { at: now - 1000 }),
      entry('land', { at: now - 2000 }),
      entry('create', { at: now - 3000 }),
      entry('answer', { at: now - 4000 }),
    ];
    const r = fleetActivityRollup(audit, now);
    expect(r.landed).toBe(2);
    expect(r.spawned).toBe(1);
    expect(r.answered).toBe(1);
    expect(r.verdict).toBe('healthy');
    expect(r.headline).toBe('landed 2 · spawned 1 · answered 1');
  });

  test('a catastrophe makes the verdict critical and is surfaced in the headline', () => {
    const r = fleetActivityRollup([entry('catastrophe', { at: now - 500, outcome: 'error', detail: 'budget exhausted' }), entry('land', { at: now - 600 })], now);
    expect(r.catastrophes).toBe(1);
    expect(r.verdict).toBe('critical');
    expect(r.headline).toContain('1 catastrophe');
  });

  test('a non-catastrophe error → warn', () => {
    const r = fleetActivityRollup([entry('land', { at: now - 100, outcome: 'error' })], now);
    expect(r.errors).toBe(1);
    expect(r.verdict).toBe('warn');
  });

  test('excludes events older than the window', () => {
    const r = fleetActivityRollup([entry('land', { at: now - 2 * 24 * 60 * 60 * 1000 })], now);
    expect(r.total).toBe(0);
    expect(r.headline).toContain('quiet');
  });
});

// ───────────────────────────── fleetActivityLines ─────────────────────────────

describe('fleetActivityLines', () => {
  test('humanizes verb + subject + kind, newest-first, capped', () => {
    const audit = [
      entry('land', { id: 3, target: 'ompsq-9-abcd1234-x-deadbeef', detail: 'merged' }),
      entry('catastrophe', { id: 2, target: 'ompsq-8-aaaa1111-y-cafebabe', outcome: 'error', detail: 'repair budget exhausted' }),
      entry('answer', { id: 1, actor: 'web:admin', target: 'plan-mqq', detail: 'Approve' }),
    ];
    const lines = fleetActivityLines(audit, [], 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ verb: 'landed', subject: 'ompsq-9', kind: 'good' });
    expect(lines[1]).toMatchObject({ verb: 'hit a catastrophe on', kind: 'bad', outcome: 'error' });
  });

  test('an answer by an operator is neutral', () => {
    const [line] = fleetActivityLines([entry('answer', { actor: 'web:admin', target: 'x' })]);
    expect(line.kind).toBe('neutral');
    expect(line.verb).toBe('answered');
  });
});

// ───────────────────────────── fleetActivityDigest ─────────────────────────────

describe('fleetActivityDigest', () => {
  test('empty → an explicit quiet sentence', () => {
    expect(fleetActivityDigest(fleetActivityRollup([], 1000), [])).toContain('quiet');
  });

  test('leads with the rollup headline and flags bad lines with ⚠', () => {
    const now = 1_000_000;
    const audit = [entry('catastrophe', { at: now - 100, outcome: 'error', target: 'ompsq-5-zzzz9999-q-12345678', detail: 'budget exhausted' })];
    const digest = fleetActivityDigest(fleetActivityRollup(audit, now), fleetActivityLines(audit, []));
    expect(digest).toContain('1 catastrophe');
    expect(digest).toContain('⚠');
    expect(digest).toContain('hit a catastrophe on ompsq-5');
  });
});
