import React from 'react';
import { useTaskContext } from '../../context/TaskContext';
import { fetchPlanReality } from '../../lib/api';
import type { PlanRealityConcernDTO, PlanRealityDTO } from '../../lib/dto';
import { planFeatures } from '../../lib/plan-reality-route';
import { claimMark, driftLines, evidenceLine, realityHeadline } from '../../lib/realitySurface';

/**
 * RealitySurface — what a plan claims, and what is actually true.
 *
 * `01-room.html` names the two zones: **WHAT IS TRUE RIGHT NOW** and **THE EVIDENCE SURVIVED**.
 * `06-other-side.html` names the rule underneath them — **HOW CLAIMS ARE MARKED FROM NOW ON**.
 *
 * The old screen drew the same data as two progress rings and four badge colours, which compresses
 * the distinction straight back out: a plan 90% done-unproven and a plan 90% done-proven draw the
 * same arc, and the arc is what a reader remembers. The number that matters here is not how much is
 * done — it is how much is claimed done with nothing behind it. So the arcs are gone and the gap is
 * the headline.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

function Zone({ label, tone, children }: { label: string; tone?: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: tone ?? '#5A5A61' }}>{label}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function RealityIndex() {
  const { features, openPlanReality } = useTaskContext();
  const plans = planFeatures(features);
  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>WHAT EACH PLAN CLAIMS · {plans.length}</div>
        <div className="mt-2.5 max-w-[640px] text-[12.5px] leading-[1.55]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
          A plan saying “done” is a claim. Open one to see how many of its claims have evidence behind them that still holds —
          this is the only screen that tells those apart.
        </div>
        {plans.length === 0 ? (
          <div className="mt-4 max-w-[620px] text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
            No plan has a directory to reconcile against. There is nothing here to check, which is not the same as everything
            checking out.
          </div>
        ) : (
          <div className="mt-4 flex flex-col">
            {plans.map((feature) => (
              <button key={feature.id} type="button" onClick={() => openPlanReality(feature.id)} className="flex items-baseline gap-3 py-2.5 text-left" style={{ borderTop: '1px solid #17171A' }}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]" style={{ color: '#DEDEE2' }}>{feature.title}</div>
                  <div className="mt-[3px] truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>{feature.planDir}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClaimRow({ concern }: { concern: PlanRealityConcernDTO }) {
  const mark = claimMark(concern.realityState);
  return (
    <div className="flex gap-3 py-2.5" style={{ borderTop: '1px solid #17171A' }}>
      <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: mark.tone }} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] leading-[1.45]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{concern.title}</div>
        {/* The mark carries its own reason. A colour alone makes the reader learn a legend. */}
        <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{mark.why}</div>
      </div>
      <div className="flex-none" style={{ fontFamily: MONO, fontSize: 10, color: mark.tone }}>{mark.label}</div>
    </div>
  );
}

function RealityDetail({ featureId }: { featureId: string }) {
  const { currentProject, closePlanReality } = useTaskContext();
  const repo = currentProject?.id ?? '';
  const [reality, setReality] = React.useState<PlanRealityDTO | null | undefined>(undefined);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setError('');
    fetchPlanReality(featureId, repo)
      .then((next) => { if (alive) setReality(next); })
      .catch((err) => { if (alive) { setReality(null); setError(err instanceof Error ? err.message : 'could not be read'); } });
    return () => { alive = false; };
  }, [featureId, repo]);

  if (reality === undefined) {
    return <div className="px-8 py-9" style={{ background: '#0A0A0B', fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>reconciling the plan against what actually happened…</div>;
  }

  if (!reality) {
    return (
      <div className="overflow-y-auto px-8 py-9" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
        <div className="max-w-[640px]">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>NOTHING HAS BEEN RECONCILED FOR THIS PLAN</div>
          <div className="mt-2.5 text-[13px] leading-[1.6]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>
            {/* A 404 here is the common case, and it is not the same as a clean bill. */}
            {error ? `${error}. ` : ''}No comparison has ever been run between what this plan says and what the repository shows.
            That is an absence of checking, not a clean bill — every “done” in it is currently somebody’s word.
          </div>
          <button type="button" onClick={closePlanReality} className="mt-4" style={{ fontFamily: MONO, fontSize: 10.5, color: '#F0A35A' }}>all plans</button>
        </div>
      </div>
    );
  }

  const { rollup, proof, concerns } = reality;
  const claimed = concerns.filter((concern) => !concern.open);
  const open = concerns.filter((concern) => concern.open);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[980px] px-8 py-8">
        <div className="flex items-baseline gap-4">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>{reality.title.toUpperCase()} · WHAT IS TRUE RIGHT NOW</div>
          <div className="flex-1" />
          <button type="button" onClick={closePlanReality} style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>all plans</button>
        </div>
        <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{reality.planDir ?? reality.repo} · reconciled {new Date(reality.generatedAt).toLocaleString()}</div>

        {/* The gap, not the progress. */}
        <div className="mt-4 text-[17px] leading-[1.5]" style={{ color: '#E8E8EA', textWrap: 'pretty', maxWidth: 740 }}>
          {realityHeadline(rollup)}
        </div>

        <Zone label="THE EVIDENCE SURVIVED" tone={rollup.proofReachable === false ? '#C2704A' : rollup.proofReachable === null ? '#8A6A45' : undefined}>
          <div className="text-[13px] leading-[1.55]" style={{ color: '#DEDEE2', textWrap: 'pretty', maxWidth: 740 }}>
            {evidenceLine(rollup, proof.reachableDetail)}
          </div>
          {proof.present ? (
            <div className="mt-2" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.8 }}>
              <div>{proof.verified ?? 'verification not recorded'} · {proof.mode ?? 'mode not recorded'}</div>
              {proof.commit ? <div>commit {proof.commit.slice(0, 12)}{proof.baseRef ? ` against ${proof.baseRef}` : ''}</div> : null}
              {proof.prUrl ? <div>{proof.prUrl}</div> : null}
            </div>
          ) : null}
        </Zone>

        <div className="flex gap-9">
          <div className="flex-1 min-w-0">
            <Zone label={`HOW EACH CLAIM IS MARKED · ${claimed.length}`}>
              {claimed.length === 0 ? (
                <div className="text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
                  Nothing claims to be done, so there is nothing to mark.
                </div>
              ) : (
                <div className="flex flex-col">{claimed.map((concern) => <ClaimRow key={concern.file} concern={concern} />)}</div>
              )}
            </Zone>

            {open.length > 0 ? (
              <Zone label={`NOT CLAIMED · ${open.length}`}>
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#5A5A61', lineHeight: 1.9 }}>
                  {open.map((concern) => (
                    <div key={concern.file} className="truncate" title={concern.title}>
                      {concern.title}{concern.blocked ? ' · blocked' : ''}
                    </div>
                  ))}
                </div>
              </Zone>
            ) : null}
          </div>

          <div className="w-[340px] flex-none">
            <Zone label="WHAT IT ACTUALLY TOUCHED">
              <div className="flex flex-col gap-2">
                {driftLines({ ...rollup.scopeDrift, actualChangedFiles: rollup.scopeDrift.actualChangedFiles }).map((line) => (
                  <div key={line} className="text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{line}</div>
                ))}
              </div>
              {rollup.scopeDrift.touchedNotPlanned.length > 0 ? (
                <div className="mt-2.5">
                  <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.12em', color: '#8A6A45' }}>NEVER MENTIONED IN THE PLAN</div>
                  <div className="mt-1" style={{ fontFamily: MONO, fontSize: 10, color: '#C9C9CF', lineHeight: 1.8 }}>
                    {rollup.scopeDrift.touchedNotPlanned.slice(0, 12).map((path) => <div key={path} className="truncate" title={path}>{path}</div>)}
                    {rollup.scopeDrift.touchedNotPlanned.length > 12 ? <div style={{ color: '#4A4A52' }}>and {rollup.scopeDrift.touchedNotPlanned.length - 12} more</div> : null}
                  </div>
                </div>
              ) : null}
            </Zone>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The standalone screen — the index until a plan is chosen. */
export function RealitySurface() {
  const { planRealityFeatureId } = useTaskContext();
  return planRealityFeatureId ? <RealityDetail featureId={planRealityFeatureId} /> : <RealityIndex />;
}

/**
 * The compact form, embedded where a plan is already being read.
 *
 * One sentence rather than two rings: the rings needed a legend, and the sentence is the finding.
 * Renders nothing when no reconciliation exists — a 404 is the common case, and an empty strip is
 * quieter than a strip announcing that it has nothing to say.
 */
export function RealityStrip({ featureId, repo }: { featureId: string; repo: string }) {
  const { openPlanReality } = useTaskContext();
  const [reality, setReality] = React.useState<PlanRealityDTO | null | undefined>(undefined);

  React.useEffect(() => {
    let alive = true;
    fetchPlanReality(featureId, repo)
      .then((next) => { if (alive) setReality(next); })
      .catch(() => { if (alive) setReality(null); });
    return () => { alive = false; };
  }, [featureId, repo]);

  if (reality === undefined) return <div style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>reconciling…</div>;
  if (!reality) return null;

  const gap = reality.rollup.doneUnproven + reality.rollup.doneStale;
  return (
    <button
      type="button"
      onClick={() => openPlanReality(featureId)}
      className="w-full px-3.5 py-2.5 text-left"
      style={{ border: '1px solid #1F1F22', borderLeft: `2px solid ${gap > 0 ? '#B4553A' : '#3E7D57'}`, background: '#0C0C0D' }}
      title="Open what this plan claims against what is true."
    >
      <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.14em', color: '#5A5A61' }}>WHAT IS TRUE RIGHT NOW</div>
      <div className="mt-1.5 text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{realityHeadline(reality.rollup)}</div>
    </button>
  );
}
