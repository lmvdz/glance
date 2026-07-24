import React from 'react';
import { AlertCircle, CheckCircle2, GitMerge, Loader2, ShieldAlert } from 'lucide-react';
import { apiJson } from '../lib/api';
import { hubHref, workbenchHref } from '../lib/router';
import type { DoneProofDTO, ValidationRecordDTO } from '../lib/dto';

interface GateVerdictProofDTO {
  mode: 'resident' | 'post-mortem';
  unitId?: string;
  unitName?: string;
  repo?: string;
  branch?: string;
  featureId?: string;
  issueIdentifier?: string;
  validation?: ValidationRecordDTO;
  doneProof?: DoneProofDTO;
  landAttempt?: { attemptId: string; terminal: string; resultCommit?: string; resultTree?: string; observedAt?: string };
  malformedLandRecords: number;
}

function splitRouteId(routeId: string | undefined): { channelId: string; entryId: string } | null {
  if (!routeId) return null;
  const separator = routeId.includes('\u0000') ? routeId.indexOf('\u0000') : routeId.indexOf('/');
  if (separator <= 0 || separator === routeId.length - 1) return null;
  return { channelId: routeId.slice(0, separator), entryId: routeId.slice(separator + 1) };
}

function pct(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'unknown';
}

function shortSha(value: string | undefined): string {
  return value ? value.slice(0, 12) : 'unknown';
}

export function GateVerdictProofView({ routeId }: { routeId?: string }) {
  const ids = splitRouteId(routeId);
  const [proof, setProof] = React.useState<GateVerdictProofDTO | null>(null);
  const [error, setError] = React.useState<string>('');
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    if (!ids) {
      setError('Gate verdict route is missing a channel or entry id.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    apiJson<{ proof: GateVerdictProofDTO }>(`/api/channels/${encodeURIComponent(ids.channelId)}/entries/${encodeURIComponent(ids.entryId)}/gate-verdict-proof`)
      .then((payload) => {
        if (!live) return;
        setProof(payload.proof);
        if (payload.proof.mode === 'resident' && payload.proof.unitId) window.location.hash = workbenchHref('intervene', payload.proof.unitId).slice(1);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not load proof record.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [routeId]);

  if (!ids) return <Shell><ErrorBox message="Gate verdict route is missing a channel or entry id." /></Shell>;
  if (loading) return <Shell><div className="flex items-center gap-2 text-sm text-zinc-300"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading proof record…</div></Shell>;
  if (error) return <Shell><ErrorBox message={error} backHref={hubHref(ids.channelId, ids.entryId)} /></Shell>;
  if (!proof) return <Shell><ErrorBox message="No proof record returned." backHref={hubHref(ids.channelId, ids.entryId)} /></Shell>;

  const validation = proof.validation;
  const criteria = validation?.perCriterion ?? [];
  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">Unit landed — proof record</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">{proof.unitName ?? proof.unitId ?? 'Departed unit'}</h1>
          <p className="mt-1 text-sm text-zinc-400">{proof.branch ?? 'unknown branch'} · {proof.repo ?? 'unknown repo'}</p>
        </div>
        <a href={hubHref(ids.channelId, ids.entryId)} className="inline-flex min-h-10 items-center rounded-full border border-zinc-700 px-3 text-xs font-semibold text-zinc-200 hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black">Back to card</a>
      </div>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-current/20 bg-black/20 text-emerald-300">
            {validation?.verdict === 'veto' ? <ShieldAlert className="h-5 w-5" aria-hidden /> : <CheckCircle2 className="h-5 w-5" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-200">{validation?.verdict ?? 'unknown'}</span>
              <span className="text-xs text-zinc-500">agreement {pct(validation?.agreement)} · confidence {pct(validation?.confidence)}</span>
            </div>
            <p className="mt-2 text-sm leading-6 text-zinc-300">{validation?.rationale ?? 'Pinned verdict payload did not include a rationale.'}</p>
          </div>
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="text-sm font-semibold text-zinc-100">Per-criterion verdict</h2>
          {criteria.length ? (
            <ul className="mt-3 divide-y divide-zinc-800">
              {criteria.map((criterion) => (
                <li key={`${criterion.id}-${criterion.note ?? ''}`} className="py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={criterion.satisfied ? 'text-emerald-300' : 'text-red-300'}>{criterion.satisfied ? '✓' : '×'}</span>
                    <span className="font-mono text-xs text-zinc-300">{criterion.id}</span>
                  </div>
                  {criterion.note ? <p className="mt-1 text-sm leading-6 text-zinc-400">{criterion.note}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-sm text-zinc-500">No per-criterion payload was pinned on this card.</p>}
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><GitMerge className="h-4 w-4" aria-hidden /> Done proof</div>
            {proof.doneProof ? (
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="verified" value={proof.doneProof.verified} />
                <Row label="commit" value={shortSha(proof.doneProof.commit)} mono />
                <Row label="merge" value={shortSha(proof.doneProof.mergeCommit)} mono />
                <Row label="base" value={proof.doneProof.baseRef} />
                <Row label="mode" value={proof.doneProof.mode} />
                {proof.doneProof.prUrl ? <Row label="PR" value={proof.doneProof.prUrl} /> : null}
              </dl>
            ) : <p className="mt-3 text-sm text-zinc-500">No done-proof matched the pinned branch or issue.</p>}
          </section>
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <h2 className="text-sm font-semibold text-zinc-100">Land assessment</h2>
            {proof.landAttempt ? (
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="attempt" value={proof.landAttempt.attemptId} mono />
                <Row label="terminal" value={proof.landAttempt.terminal} />
                <Row label="result" value={shortSha(proof.landAttempt.resultCommit)} mono />
                <Row label="observed" value={proof.landAttempt.observedAt ?? 'unknown'} />
              </dl>
            ) : <p className="mt-3 text-sm text-zinc-500">No land-assessment event matched this unit, feature, or done-proof commit.</p>}
            {proof.malformedLandRecords ? <p className="mt-3 text-xs text-amber-200">{proof.malformedLandRecords} malformed land-assessment record(s) were counted and ignored.</p> : null}
          </section>
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="min-h-full overflow-y-auto bg-[#09090a] p-5 text-zinc-100"><div className="mx-auto max-w-5xl">{children}</div></main>;
}

function ErrorBox({ message, backHref }: { message: string; backHref?: string }) {
  return <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100" role="alert"><div className="flex items-center gap-2"><AlertCircle className="h-4 w-4" aria-hidden /> {message}</div>{backHref ? <a href={backHref} className="mt-3 inline-flex min-h-10 items-center rounded-full border border-red-300/30 px-3 text-xs font-semibold hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black">Back to card</a> : null}</div>;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="flex items-start justify-between gap-3"><dt className="text-xs uppercase tracking-[0.12em] text-zinc-500">{label}</dt><dd className={`text-right text-zinc-300 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd></div>;
}
