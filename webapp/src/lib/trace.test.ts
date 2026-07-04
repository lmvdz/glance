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

  // Regression guard: seconds used to round independently of minutes, so a leftover remainder near
  // a 60s boundary could round UP to "60" while the whole-minute count stayed put.
  test('minute rollover boundary: 119_600ms rounds to 2m 00s, not 1m 60s', () => {
    expect(formatDurationMs(119_600)).toBe('2m 00s');
  });

  test('hour rollover boundary: 3_599_600ms (3599.6s) rounds to 1h 00m, not 59m 60s', () => {
    expect(formatDurationMs(3_599_600)).toBe('1h 00m');
  });

  test('sub-minute boundary: 59_960ms rounds to 1m 00s, not 60.0s', () => {
    expect(formatDurationMs(59_960)).toBe('1m 00s');
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
