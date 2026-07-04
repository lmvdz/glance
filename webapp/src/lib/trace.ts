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

/** Formats a millisecond duration as a short human string: `840ms`, `12.3s`, `4m 05s`, `1h 02m`. */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec - totalMin * 60);
  if (totalMin < 60) return `${totalMin}m ${String(sec).padStart(2, '0')}s`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin - hr * 60;
  return `${hr}h ${String(min).padStart(2, '0')}m`;
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—';
  return `$${usd.toFixed(2)}`;
}
