import { describe, expect, test } from 'bun:test';
import { parseAgentHash } from './agent-link';

describe('parseAgentHash', () => {
  test('parses the exact shape both producers emit (push payloads and glance here)', () => {
    expect(parseAgentHash('#/agent/chat-mrnj5f9p-1-4b929b25')).toBe('chat-mrnj5f9p-1-4b929b25');
    expect(parseAgentHash('#/agent/agent-3')).toBe('agent-3');
  });

  test('decodes percent-encoded ids (hereWebUrl encodes with encodeURIComponent)', () => {
    expect(parseAgentHash(`#/agent/${encodeURIComponent('chat/one two')}`)).toBe('chat/one two');
  });

  test('rejects everything that is not an agent deep link', () => {
    expect(parseAgentHash('')).toBeUndefined();
    expect(parseAgentHash('#/')).toBeUndefined();
    expect(parseAgentHash('#/agent')).toBeUndefined();
    expect(parseAgentHash('#/agent/')).toBeUndefined();
    expect(parseAgentHash('#/review/task-1')).toBeUndefined();
    expect(parseAgentHash('#/agents/x')).toBeUndefined();
  });

  test('strips a `?push=1` query-string suffix from the captured id — a parser invariant, not a '
    + 'side effect of running after push-tap.ts\'s beacon strip', () => {
    expect(parseAgentHash('#/agent/chat-1?push=1')).toBe('chat-1');
  });

  test('leaves an id with no query-string suffix untouched', () => {
    expect(parseAgentHash('#/agent/chat-1')).toBe('chat-1');
  });

  test('strips any `?...` suffix, not just the push marker — the parser never returns an id '
    + 'containing `?`', () => {
    expect(parseAgentHash('#/agent/chat-1?view=diff')).toBe('chat-1');
    expect(parseAgentHash('#/agent/chat-1?push=1&view=diff')).toBe('chat-1');
  });
});
