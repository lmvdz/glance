import React from 'react';
import { CheckCircle2, ExternalLink, ShieldAlert } from 'lucide-react';
import { apiJson } from '../../lib/api';
import { entryTimeLabel } from '../../lib/hub';
import { gateVerdictHref, workbenchHref } from '../../lib/router';
import type { ChannelCardTone, ChannelCardView } from '../../lib/channelTimeline';
import type { ValidationRecordDTO } from '../../lib/dto';

interface GateVerdictProofResponse {
  proof: {
    mode: 'resident' | 'post-mortem';
    unitId?: string;
  };
}

const toneClass: Record<ChannelCardTone, string> = {
  neutral: 'border-zinc-800 bg-[#0c0c0e] text-zinc-200',
  info: 'border-sky-400/25 bg-sky-400/7 text-zinc-100',
  warning: 'border-amber-400/35 bg-amber-400/10 text-amber-50',
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-50',
  destructive: 'border-red-400/35 bg-red-400/10 text-red-50',
};

function recordObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function validationRecord(value: unknown): ValidationRecordDTO | undefined {
  const rec = recordObject(value);
  if (!rec) return undefined;
  if (rec.verdict !== 'pass' && rec.verdict !== 'veto' && rec.verdict !== 'abstain' && rec.verdict !== 'skipped' && rec.verdict !== 'inconclusive') return undefined;
  if (typeof rec.agreement !== 'number' || typeof rec.confidence !== 'number' || typeof rec.rationale !== 'string' || typeof rec.ranAt !== 'number') return undefined;
  if (!Array.isArray(rec.perCriterion)) return undefined;
  return rec as unknown as ValidationRecordDTO;
}

function pct(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'unknown';
}

function refsFor(view: ChannelCardView): { channelId: string; entryId: string; unitId?: string } {
  const payload = recordObject(view.entry.event?.payload) ?? {};
  const refs = recordObject(payload.refs) ?? {};
  return {
    channelId: view.entry.channelId,
    entryId: view.entry.id,
    unitId: typeof refs.unitId === 'string' ? refs.unitId : undefined,
  };
}

export function GateVerdictCard({ view }: { view: ChannelCardView }) {
  const [opening, setOpening] = React.useState(false);
  const [error, setError] = React.useState<string>('');
  const face = recordObject(recordObject(view.entry.event?.payload)?.face) ?? {};
  const validation = validationRecord(face.validation);
  const refs = refsFor(view);
  const verdict = validation?.verdict ?? (typeof face.verdict === 'string' ? face.verdict : 'unknown');
  const criteria = validation?.perCriterion ?? [];
  const doorHref = gateVerdictHref(refs.channelId, refs.entryId);

  const openDoor = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (opening) return;
    setOpening(true);
    setError('');
    try {
      const response = await apiJson<GateVerdictProofResponse>(`/api/channels/${encodeURIComponent(refs.channelId)}/entries/${encodeURIComponent(refs.entryId)}/gate-verdict-proof`);
      if (response.proof.mode === 'resident' && response.proof.unitId) window.location.hash = workbenchHref('intervene', response.proof.unitId).slice(1);
      else window.location.hash = doorHref.slice(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Door failed');
    } finally {
      setOpening(false);
    }
  };

  return (
    <li data-entry-id={view.id} className="group flex justify-start">
      <article className={`w-full rounded-2xl border px-3 py-3 text-sm shadow-sm transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 ${toneClass[view.tone]}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-current/20 bg-black/20">
            {verdict === 'veto' ? <ShieldAlert className="h-4 w-4" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {view.eyebrow ? <span className="text-[10px] font-medium uppercase tracking-[0.14em] opacity-60">{view.eyebrow}</span> : null}
              <span className="rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] opacity-80">gate verdict</span>
              <span className="text-[10px] uppercase tracking-[0.14em] opacity-55">{view.authorLabel}</span>
              <time dateTime={new Date(view.entry.ts).toISOString()} className="text-[10px] tabular-nums opacity-50">{entryTimeLabel(view.entry.ts)}</time>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight">{view.title}</h3>
              <span className="rounded-full border border-current/20 bg-black/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]">{verdict}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 opacity-85">{validation?.rationale || view.body}</p>
            <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-current/10 bg-black/10 px-2 py-1.5">
                <dt className="text-[10px] uppercase tracking-[0.12em] opacity-50">Agreement</dt>
                <dd className="mt-0.5 truncate text-xs font-medium">{pct(validation?.agreement)}</dd>
              </div>
              <div className="rounded-lg border border-current/10 bg-black/10 px-2 py-1.5">
                <dt className="text-[10px] uppercase tracking-[0.12em] opacity-50">Confidence</dt>
                <dd className="mt-0.5 truncate text-xs font-medium">{pct(validation?.confidence)}</dd>
              </div>
              <div className="rounded-lg border border-current/10 bg-black/10 px-2 py-1.5">
                <dt className="text-[10px] uppercase tracking-[0.12em] opacity-50">Unit</dt>
                <dd className="mt-0.5 truncate text-xs font-medium">{typeof face.unitName === 'string' ? face.unitName : refs.unitId ?? 'unknown'}</dd>
              </div>
            </dl>
            {criteria.length ? (
              <div className="mt-3 rounded-xl border border-current/10 bg-black/10 p-2">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] opacity-50">Criteria</div>
                <ul className="mt-1 space-y-1">
                  {criteria.map((item) => {
                    const criterion = recordObject(item);
                    const id = typeof criterion?.id === 'string' ? criterion.id : 'criterion';
                    const satisfied = criterion?.satisfied === true;
                    const note = typeof criterion?.note === 'string' ? criterion.note : '';
                    return <li key={`${id}-${note}`} className="text-xs leading-5 opacity-80"><span className="font-mono">{satisfied ? '✓' : '×'} {id}</span>{note ? ` — ${note}` : ''}</li>;
                  })}
                </ul>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a href={doorHref} onClick={openDoor} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-current/20 bg-black/20 px-3 text-xs font-semibold hover:bg-black/30 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                {opening ? 'Opening proof…' : 'Open proof record'}
              </a>
              <span className="text-[11px] opacity-55">Resident units open live; departed units open post-mortem.</span>
            </div>
            {error ? <p className="mt-2 text-xs text-red-200" role="alert">{error}</p> : null}
          </div>
        </div>
      </article>
    </li>
  );
}
