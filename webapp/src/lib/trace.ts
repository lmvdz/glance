/**
 * Client-side trace helpers — pure logic backing the WorkflowGraphOverlay drill-in panel.
 * Kept separate from the component so it stays unit-testable without mounting React.
 */

/** Mirrors src/spans.ts's traceIdFor: `feat:<featureId>` for feature work, else
 *  `run:<agentId>:<receiptRunId>`. Prefers `featureId` (stable across every run under that feature);
 *  otherwise falls back to `agent.traceId` — the SAME id-space the server's `GET /api/trace/:id` and
 *  `matchesTrace` (spans.ts) require, because it's minted by the identical `RunAccumulator`/
 *  `SpanCollector` that produces `RunReceipt.traceId`. `agent.workflowState.runId` is NOT usable here:
 *  it's the workflow ENGINE's own run id (`<agentId>:<base36ts>`, workflow-driver.ts), a different
 *  id-space from the receipt runId (`Date.now().toString(36)`, receipts.ts) that never matches a real
 *  trace — a prior version of this function built `run:${agentId}:${workflowState.runId}` from it and
 *  404'd every time. Returns undefined when neither is known yet (e.g. a workflow whose first node
 *  hasn't started) — there is nothing to fetch yet. */
export function traceIdForAgent(agent: { id: string; featureId?: string; traceId?: string }): string | undefined {
  if (agent.featureId) return `feat:${agent.featureId}`;
  return agent.traceId;
}

/** Formats a millisecond duration as a short human string: `840ms`, `12.3s`, `4m 05s`, `1h 02m`.
 *  Seconds/minutes/hours are derived from a SINGLE rounded total (not rounded independently per
 *  unit), so a value like 119_600ms can't round its leftover 59.6s up to "60s" while its whole
 *  minutes stay at 1 — the old per-unit rounding produced exactly that ("1m 60s", or "59m 60s" for
 *  3599.6s). Rounding the whole-second total first, then splitting THAT integer into minutes/hours,
 *  makes a 60-rollover carry into the next unit instead of ever being displayed. */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  // 59.95s..60s would itself round to "60.0s" on the fixed-decimal path below — promote it to the
  // whole-second/minute path instead so it becomes "1m 00s".
  if (totalSec < 59.95) return `${totalSec.toFixed(1)}s`;
  const roundedSec = Math.round(totalSec);
  const totalMin = Math.floor(roundedSec / 60);
  const sec = roundedSec - totalMin * 60;
  if (totalMin < 60) return `${totalMin}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin - hr * 60;
  return `${hr}h ${String(min).padStart(2, '0')}m`;
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(2)}`;
}
