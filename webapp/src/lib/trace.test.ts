/**
 * trace.test.ts — the pure logic backing the trace drill-in panel: trace-id derivation and
 * display formatters. The panel itself needs fetch + DOM, so (like the other panel tests) we
 * verify only the extracted logic here.
 */

import { describe, expect, test } from 'bun:test';
import { traceIdForAgent, formatDurationMs, formatUsd } from './trace';

describe('traceIdForAgent', () => {
  test('featureId present → feat:<featureId>, regardless of traceId', () => {
    expect(traceIdForAgent({ id: 'a1', featureId: 'F42', traceId: 'run:a1:abc123' })).toBe('feat:F42');
  });

  test('no featureId, traceId present → the server-minted traceId verbatim (receipt id-space, not workflowState.runId)', () => {
    expect(traceIdForAgent({ id: 'a1', traceId: 'run:a1:abc123' })).toBe('run:a1:abc123');
  });

  // Regression guard: traceIdForAgent must never reconstruct a trace id from workflowState.runId
  // (the engine's own `<agentId>:<base36ts>` run id) — that id-space never matches a real
  // `RunReceipt.traceId`/`matchesTrace` (spans.ts), so it 404s 100% of the time it fires. The
  // narrowed parameter type (no `workflowState`) makes that mistake a compile error, not just a
  // runtime one.
  test('no featureId, no traceId → undefined (nothing to fetch yet — no live/completed run)', () => {
    expect(traceIdForAgent({ id: 'a1' })).toBeUndefined();
  });
});

describe('formatDurationMs', () => {
  test('undefined/negative/NaN → em dash', () => {
    expect(formatDurationMs(undefined)).toBe('—');
    expect(formatDurationMs(-5)).toBe('—');
    expect(formatDurationMs(Number.NaN)).toBe('—');
  });
  test('sub-second → whole ms', () => {
    expect(formatDurationMs(840)).toBe('840ms');
  });
  test('seconds → one decimal', () => {
    expect(formatDurationMs(12300)).toBe('12.3s');
  });
  test('minutes → m + zero-padded s', () => {
    expect(formatDurationMs(245_000)).toBe('4m 05s');
  });
  test('hours → h + zero-padded m', () => {
    expect(formatDurationMs(3_720_000)).toBe('1h 02m');
  });
});

describe('formatUsd', () => {
  test('undefined/NaN → em dash', () => {
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
  });
  test('formats to two decimals with a dollar sign', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
