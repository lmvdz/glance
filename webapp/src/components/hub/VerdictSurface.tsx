import React from 'react';
import { apiJson } from '../../lib/api';
import { hubHref, unitHref } from '../../lib/router';
import type { DoneProofDTO, ValidationRecordDTO } from '../../lib/dto';
import { absences, confidenceLine, consideredNotSurfaced, notSurfacedSentence, restsOn, verdictSentence } from '../../lib/gateVerdict';

/**
 * VerdictSurface — a judgement, opened from the card that made it.
 *
 * `02-surfaces.html`: *"That is a judgement, so here is what it rests on. You should be able to
 * disagree with it in under a minute — and this view closes itself again, because reading it is not
 * the job."* Everything about the layout follows from that last clause. It is a page you are meant to
 * leave, so it opens on the argument and keeps the record underneath it.
 *
 * Replaces the old proof view, which opened with a status chip reading the raw verdict string — and
 * rendered **unknown** when nothing had been pinned, which is a verdict of unsure rather than the
 * absence of one. It also gave the per-criterion rows, the done proof and the land assessment equal
 * weight, so the check that nearly stopped the unit sat in the same grey as the one nobody was worried
 * about.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

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
  // The router joins channel and entry with a NUL, because either may legitimately contain a slash.
  const separator = routeId.includes('\u0000') ? routeId.indexOf('\u0000') : routeId.indexOf('/');
  if (separator <= 0 || separator === routeId.length - 1) return null;
  return { channelId: routeId.slice(0, separator), entryId: routeId.slice(separator + 1) };
}

const shortSha = (value: string | undefined): string => (value ? value.slice(0, 12) : 'not recorded');

function Zone({ label, tone, children }: { label: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: tone ?? '#5A5A61' }}>{label}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

export function VerdictSurface({ routeId }: { routeId?: string }) {
  const ids = splitRouteId(routeId);
  const [proof, setProof] = React.useState<GateVerdictProofDTO | null>(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  // The firehose opens on request, never by default.
  const [recordOpen, setRecordOpen] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    if (!ids) { setError('This link is missing the card it was meant to open.'); setLoading(false); return; }
    setLoading(true);
    setError('');
    apiJson<{ proof: GateVerdictProofDTO }>(`/api/channels/${encodeURIComponent(ids.channelId)}/entries/${encodeURIComponent(ids.entryId)}/gate-verdict-proof`)
      .then((payload) => {
        if (!live) return;
        setProof(payload.proof);
        // A unit that is still resident has a room of its own; that is a better place to stand than a
        // post-mortem record of it.
        if (payload.proof.mode === 'resident' && payload.proof.unitId) window.location.hash = unitHref(payload.proof.unitId).slice(1);
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'The record behind this verdict could not be read.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [routeId]);

  const back = ids ? hubHref(ids.channelId, ids.entryId) : hubHref();

  if (loading) {
    return <div className="px-8 py-9" style={{ background: '#0A0A0B', fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reading the record behind this verdict…</div>;
  }
  if (error || !proof) {
    return (
      <div className="overflow-y-auto px-8 py-9" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
        <div className="max-w-[620px]">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>THE RECORD COULD NOT BE READ</div>
          <div className="mt-2.5 text-[13px] leading-[1.6]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>
            {error || 'Nothing came back for this card.'} That is a failed read, not a verdict — nothing about whether this unit passed should be taken from this screen.
          </div>
          <a href={back} className="mt-4 inline-block" style={{ fontFamily: MONO, fontSize: 10.5, color: '#F0A35A' }}>back to the card</a>
        </div>
      </div>
    );
  }

  const validation = proof.validation;
  const criteria = validation?.perCriterion ?? [];
  const carried = restsOn(criteria);
  const quiet = consideredNotSurfaced(criteria);
  const sure = confidenceLine({ agreement: validation?.agreement, confidence: validation?.confidence });
  const missing = absences(proof);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-8">
        <div className="flex items-baseline gap-4">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>
            A VERDICT · {(proof.unitName ?? proof.unitId ?? 'a departed unit').toUpperCase()} · {(proof.branch ?? 'no branch recorded').toUpperCase()}
          </div>
          <div className="flex-1" />
          <a href={back} style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>esc closes · returns to the card</a>
        </div>

        {/* The judgement as a sentence, not a chip. */}
        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ color: '#E8E8EA', textWrap: 'pretty', maxWidth: 700 }}>
          {verdictSentence({ unitName: proof.unitName ?? proof.unitId, verdict: validation?.verdict, agreement: validation?.agreement, confidence: validation?.confidence })}
        </div>
        {sure ? <div className="mt-2" style={{ fontFamily: MONO, fontSize: 10.5, color: '#6A6A72' }}>{sure} stated, not scored</div> : null}
        {validation?.rationale ? (
          <div className="mt-3 text-[13px] leading-[1.55]" style={{ color: '#C9C9CF', textWrap: 'pretty', maxWidth: 700 }}>“{validation.rationale}”</div>
        ) : null}

        {carried.length > 0 ? (
          <Zone label="WHAT THE VERDICT RESTS ON">
            <div className="flex flex-col">
              {carried.map((criterion) => (
                <div key={`${criterion.id}-${criterion.note ?? ''}`} className="flex gap-3 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
                  <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: criterion.satisfied ? '#3E7D57' : '#B4553A' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px]" style={{ color: '#DEDEE2' }}>{criterion.id}</div>
                    {criterion.note ? <div className="mt-[3px] text-[11.5px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{criterion.note}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </Zone>
        ) : null}

        <Zone label="CONSIDERED, AND DELIBERATELY NOT SURFACED">
          <div className="text-[12px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty', maxWidth: 700 }}>{notSurfacedSentence(quiet.length)}</div>
          {quiet.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1" style={{ fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>
              {quiet.map((criterion) => <span key={criterion.id}>{criterion.id}</span>)}
            </div>
          ) : null}
        </Zone>

        {missing.length > 0 ? (
          <Zone label="WHAT IS NOT IN THIS RECORD" tone="#8A6A45">
            <div className="flex flex-col gap-1.5">
              {missing.map((line) => (
                <div key={line} className="text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty', maxWidth: 700 }}>{line}</div>
              ))}
            </div>
          </Zone>
        ) : null}

        {/* Opens on request, never by default: the record is what you check the argument against, not
            what you read first. */}
        <div className="mt-7" style={{ borderTop: '1px solid #1F1F22', paddingTop: 12 }}>
          <button type="button" onClick={() => setRecordOpen((open) => !open)} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
            {recordOpen ? 'CLOSE THE RECORD' : 'THE RECORD ITSELF ›'}
          </button>
          {recordOpen ? (
            <div className="mt-3 flex gap-10" style={{ fontFamily: MONO, fontSize: 10.5, color: '#6A6A72', lineHeight: 1.9 }}>
              <div>
                <div style={{ color: '#4A4A52', letterSpacing: '.12em' }}>DONE PROOF</div>
                {proof.doneProof ? (
                  <>
                    <div>verified&nbsp;&nbsp;{String(proof.doneProof.verified)}</div>
                    <div>commit&nbsp;&nbsp;{shortSha(proof.doneProof.commit)}</div>
                    <div>merge&nbsp;&nbsp;{shortSha(proof.doneProof.mergeCommit)}</div>
                    <div>base&nbsp;&nbsp;{proof.doneProof.baseRef ?? 'not recorded'}</div>
                  </>
                ) : <div style={{ color: '#4A4A52' }}>none found</div>}
              </div>
              <div>
                <div style={{ color: '#4A4A52', letterSpacing: '.12em' }}>LAND ASSESSMENT</div>
                {proof.landAttempt ? (
                  <>
                    <div>attempt&nbsp;&nbsp;{proof.landAttempt.attemptId}</div>
                    <div>terminal&nbsp;&nbsp;{proof.landAttempt.terminal}</div>
                    <div>result&nbsp;&nbsp;{shortSha(proof.landAttempt.resultCommit)}</div>
                    <div>observed&nbsp;&nbsp;{proof.landAttempt.observedAt ?? 'not recorded'}</div>
                  </>
                ) : <div style={{ color: '#4A4A52' }}>none found</div>}
              </div>
              <div>
                <div style={{ color: '#4A4A52', letterSpacing: '.12em' }}>WHERE</div>
                <div>{proof.repo ?? 'repo not recorded'}</div>
                <div>{proof.branch ?? 'branch not recorded'}</div>
                {proof.issueIdentifier ? <div>{proof.issueIdentifier}</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
