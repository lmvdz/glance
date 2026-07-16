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
});
