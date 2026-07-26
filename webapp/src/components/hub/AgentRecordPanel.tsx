import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { apiJson } from '../../lib/api';
import { workbenchHref } from '../../lib/router';
import type { AgentDTO } from '../../lib/dto';

type ClaimState = 'current' | 'stale' | 'withdrawn';
interface AgentRecordView {
  agentId: string;
  roleDefault?: string;
  provisional: boolean;
  checking?: { requiredUnits: number; checkedUnits: number; reviewerId?: string };
  profileMissing: boolean;
  claims: Array<{ id: string; claim: string; verification: 'checked' | 'agent-word' | 'unverifiable'; sampleSize: number; date: number; state: ClaimState; sourceNodeIds: string[] }>;
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function claimCopy(claim: AgentRecordView['claims'][number]): string {
  const basis = `${claim.sampleSize} ${claim.sampleSize === 1 ? 'unit' : 'units'} · ${DATE.format(claim.date)}`;
  if (claim.state === 'withdrawn') return `${basis} · withdrawn; it remains here because it was true to its evidence then.`;
  if (claim.state === 'stale') return `${basis} · stale; check the source units before relying on it.`;
  return `${basis} · ${claim.verification === 'checked' ? 'checked' : claim.verification === 'agent-word' ? 'reported by the agent' : 'not verifiable right now'}.`;
}

export function AgentRecordPanel({ agent }: { agent: AgentDTO }) {
  const [record, setRecord] = useState<AgentRecordView>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRecord(await apiJson<AgentRecordView>(`/api/agents/${encodeURIComponent(agent.id)}/record`));
    } catch {
      setRecord(undefined);
      setError('Could not load this record. Try again; no claim is being assumed true.');
    } finally {
      setLoading(false);
    }
  }, [agent.id]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="border-b border-ink-border bg-panel px-4 py-3" aria-label={`${agent.name || agent.id} record`} aria-busy={loading}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-ink-text-subtle">Record, not a score</p>
          <p className="mt-1 text-sm text-ink-text-body">{record?.roleDefault ? `Configured for ${record.roleDefault}.` : 'Could not verify this agent’s configured role.'}</p>
        </div>
        <button type="button" onClick={() => void load()} className="flex h-10 w-10 items-center justify-center rounded-md text-ink-text-muted hover:bg-ink-surface hover:text-ink-text focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink" aria-label="Reload agent record" disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
        </button>
      </div>
      {loading ? <div className="mt-3 space-y-2" aria-label="Loading agent record"><div className="h-4 w-2/3 animate-pulse rounded bg-ink-surface motion-reduce:animate-none" /><div className="h-12 rounded bg-ink-surface animate-pulse motion-reduce:animate-none" /></div> : null}
      {error ? <div className="mt-3 flex items-start gap-2 rounded-md border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200"><AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden /><p>{error}</p></div> : null}
      {!loading && !error && record ? <>
        {record.provisional ? <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-ink-text-body">Provisional and being checked: {record.checking?.checkedUnits ?? 0} of {record.checking?.requiredUnits ?? 0} units reviewed. This is a safeguard, not a judgement.</p> : record.profileMissing ? <p className="mt-3 text-xs text-ink-text-muted">Could not verify whether this agent is provisional. There is no onboarding record yet.</p> : null}
        {record.claims.length === 0 ? <p className="mt-3 text-xs leading-5 text-ink-text-muted">No proven behaviour is recorded yet. The role above is a default, not a prediction.</p> : <ul className="mt-3 space-y-2">{record.claims.map((claim) => <li key={claim.id} className="rounded-md border border-ink-border bg-ink px-3 py-2"><p className="text-sm text-ink-text-body">{claim.claim}</p><p className="mt-1 font-mono text-[11px] leading-5 text-ink-text-muted">{claimCopy(claim)}</p><div className="mt-2 flex flex-wrap gap-2">{claim.sourceNodeIds.map((sourceId) => <a key={sourceId} href={workbenchHref('intervene', sourceId)} className="min-h-10 rounded-md border border-ink-border px-2 py-2 font-mono text-[11px] text-ember-link hover:bg-ink-surface focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink">Open unit {sourceId}</a>)}</div></li>)}</ul>}
      </> : null}
    </section>
  );
}
