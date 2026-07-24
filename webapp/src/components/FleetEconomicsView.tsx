import React from 'react';
import { Flame } from 'lucide-react';
import { apiJson } from '../lib/api';
import { PanelShell, SectionCard, StatTile } from './ui';

interface ReceiptRun {
  agentId: string;
  name: string;
  lane?: string;
  model?: string;
  toolCalls: number;
  costUsd?: number;
  tokens?: { total: number } | number;
}

interface UsagePayload {
  runs: ReceiptRun[];
}

interface EconomicsBucket {
  key: string;
  runs: number;
  units: number;
  tokens: number;
  costUsd: number;
  toolCalls: number;
}

interface FleetEconomics {
  runs: number;
  units: number;
  tokens: number;
  costUsd: number;
  toolCalls: number;
  byUnit: EconomicsBucket[];
  byLane: EconomicsBucket[];
  byModel: EconomicsBucket[];
}

function runTokens(run: ReceiptRun): number {
  return typeof run.tokens === 'number' ? run.tokens : run.tokens?.total ?? 0;
}

function aggregate(runs: ReceiptRun[], keyOf: (run: ReceiptRun) => string | undefined): EconomicsBucket[] {
  const buckets = new Map<string, EconomicsBucket & { unitIds: Set<string> }>();
  for (const run of runs) {
    const key = keyOf(run)?.trim() || 'unknown';
    const bucket = buckets.get(key) ?? { key, runs: 0, units: 0, tokens: 0, costUsd: 0, toolCalls: 0, unitIds: new Set<string>() };
    bucket.runs += 1;
    bucket.unitIds.add(run.agentId);
    bucket.units = bucket.unitIds.size;
    bucket.tokens += runTokens(run);
    bucket.costUsd += run.costUsd ?? 0;
    bucket.toolCalls += run.toolCalls;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(({ unitIds: _unitIds, ...bucket }) => bucket)
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.key.localeCompare(b.key));
}

export function buildFleetEconomicsView(runs: ReceiptRun[]): FleetEconomics {
  return {
    runs: runs.length,
    units: new Set(runs.map((run) => run.agentId)).size,
    tokens: runs.reduce((sum, run) => sum + runTokens(run), 0),
    costUsd: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    byUnit: aggregate(runs, (run) => run.name || run.agentId),
    byLane: aggregate(runs, (run) => run.lane),
    byModel: aggregate(runs, (run) => run.model),
  };
}

const fmtTokens = (n: number) => n.toLocaleString();
const fmtUsd = (n: number) => `$${n.toFixed(4)}`;

function BucketTable({ title, rows }: { title: string; rows: EconomicsBucket[] }) {
  return (
    <SectionCard title={title} right={<span className="font-mono text-[11px]">{rows.length}</span>}>
      {rows.length === 0 ? (
        <div className="p-4 text-sm text-gray-500 dark:text-gray-400">No receipt rows yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-gray-200 text-[11px] uppercase tracking-[0.12em] text-gray-500 dark:border-gray-800">
              <tr>
                <th className="px-4 py-2 font-medium">Key</th>
                <th className="px-4 py-2 font-medium">Runs</th>
                <th className="px-4 py-2 font-medium">Units</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Cost</th>
                <th className="px-4 py-2 font-medium">Tools</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="max-w-[18rem] truncate px-4 py-2 font-medium text-gray-900 dark:text-gray-100" title={row.key}>{row.key}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.runs}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.units}</td>
                  <td className="px-4 py-2 font-mono text-xs">{fmtTokens(row.tokens)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{fmtUsd(row.costUsd)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

export function FleetEconomicsView() {
  const [economics, setEconomics] = React.useState<FleetEconomics | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    apiJson<UsagePayload>('/api/usage?limit=1000')
      .then((payload) => {
        if (alive) setEconomics(buildFleetEconomicsView(payload.runs ?? []));
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load fleet economics');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PanelShell
      title="Fleet economics"
      subtitle="Receipt-backed burn by unit, lane, and model. Same fields as GET /api/usage roster receipts; no separate accounting."
      icon={<Flame className="h-5 w-5" aria-hidden />}
    >
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" role="alert">{error}</div> : null}
      {!economics ? (
        <div className="space-y-2" aria-label="Loading fleet economics">
          {[1, 2, 3].map((n) => <div key={n} className="h-20 rounded-xl border border-gray-200 bg-gray-50 skeleton dark:border-gray-800 dark:bg-gray-900" />)}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Runs" value={String(economics.runs)} />
            <StatTile label="Units" value={String(economics.units)} />
            <StatTile label="Tokens" value={fmtTokens(economics.tokens)} />
            <StatTile label="Cost" value={fmtUsd(economics.costUsd)} />
            <StatTile label="Tools" value={String(economics.toolCalls)} />
          </div>
          <BucketTable title="By unit" rows={economics.byUnit} />
          <BucketTable title="By lane" rows={economics.byLane} />
          <BucketTable title="By model" rows={economics.byModel} />
        </div>
      )}
    </PanelShell>
  );
}
