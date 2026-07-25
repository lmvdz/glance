/**
 * PlanRealityView — "plan vs reality" comprehension screen (OMPSQ-448).
 *
 * Answers one question per plan: what does the plan say is done, and is that actually proven?
 * Backend contract: `GET /api/features/:id/reality?repo=<repo>` → `{ reality: PlanRealityDTO }`
 * (404 ⇒ no plan-reality data yet for that feature — a normal state, not an error).
 *
 * Two placements share this file:
 *   - `PlanRealityView` — the standalone, deep-linkable screen (`#/plan-reality[/:featureId]`,
 *     see `lib/plan-reality-route.ts`). No `featureId` ⇒ the plans index (every feature with a
 *     `planDir`, each a card with its two rollup rings, fetched on mount); a `featureId` ⇒ the
 *     full single-plan comprehension page (header rollup, ① Planned DAG, ② Implemented + ③ Proof
 *     per-concern list, scope-drift detail).
 *   - `PlanRealityStrip` — the compact summary TaskDetail embeds when the current task's feature
 *     has a `planDir`; clicking it routes into the standalone screen for that same feature.
 *
 * ② and ③ are rendered as ONE unified per-row list, not two separate bands: proof is
 * feature-level (one proof, shown in the header), reflected onto each done concern via
 * `realityState` — there is no per-concern proof artifact to fabricate.
 */

import React from 'react';
import { ArrowLeft, GitCompare } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { fetchPlanReality } from '../lib/api';
import type { FeatureDTO, PlanRealityConcernDTO, PlanRealityDTO } from '../lib/dto';
import { planFeatures } from '../lib/plan-reality-route';
import {
  realityStateBadge,
  blockedBadge,
  verifiedBadge,
  reachabilityBadge,
  proofRingTone,
  scopeDriftLabel,
} from '../lib/plan-reality-ui';
import { ProgressRing } from './kit/ProgressRing';
import { PanelSection } from './kit/PanelSection';
import { PlanFlowDiagram } from './PlanFlowDiagram';
import type { GraphConcernInput } from '../lib/planGraph';

function toGraphConcerns(concerns: PlanRealityConcernDTO[]): GraphConcernInput[] {
  return concerns.map((c) => ({
    file: c.path,
    title: c.title,
    status: c.status,
    open: c.open,
    complexity: c.complexity,
    prerequisites: c.prerequisites,
    touches: c.touches,
  }));
}

// ── plans index ────────────────────────────────────────────────────────────────────────────────

function PlanRealityCard({ feature, onOpen }: { feature: FeatureDTO; onOpen: () => void }) {
  // undefined = loading, null = 404 (no data), DTO = loaded
  const [reality, setReality] = React.useState<PlanRealityDTO | null | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetchPlanReality(feature.id, feature.repo)
      .then((r) => { if (alive) setReality(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load.'); });
    return () => { alive = false; };
  }, [feature.id, feature.repo]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col items-start gap-3 rounded-xl border border-ink-border bg-white p-4 text-left shadow-sm transition-colors hover:border-ink-border-2 focus-visible:ring-2 focus-visible:ring-amber-500 border-ink-border bg-ink dark:hover:border-ink-border-2"
    >
      <div className="w-full min-w-0">
        <div className="truncate text-sm font-semibold text-ink-text">{feature.title}</div>
        {feature.planDir && <div className="mt-0.5 truncate font-mono text-caption text-ink-text-subtle">{feature.planDir}</div>}
      </div>
      {error ? (
        <div className="text-xs text-red-500 dark:text-red-400">{error}</div>
      ) : reality === undefined ? (
        <div className="flex items-center gap-3 py-1" aria-label="Loading">
          <div className="h-14 w-14 animate-pulse rounded-full bg-ink-surface" />
          <div className="h-14 w-14 animate-pulse rounded-full bg-ink-surface" />
        </div>
      ) : reality === null ? (
        <div className="text-xs text-ink-text-subtle">No plan-reality data yet.</div>
      ) : (
        <div className="flex items-center gap-4">
          <ProgressRing value={reality.rollup.done} total={reality.rollup.totalConcerns} label="done" size={56} strokeWidth={6} />
          <ProgressRing
            value={reality.rollup.doneProven}
            total={reality.rollup.done}
            label="proven"
            tone={proofRingTone(reality.rollup)}
            size={56}
            strokeWidth={6}
          />
        </div>
      )}
    </button>
  );
}

function PlanRealityIndex() {
  const { features, openPlanReality } = useTaskContext();
  const plans = React.useMemo(() => planFeatures(features), [features]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex-shrink-0 border-b border-ink-border px-6 py-4 border-ink-border">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink-text">
          <GitCompare className="h-4 w-4 text-[color:var(--wf-accent)]" aria-hidden="true" />
          Plan vs reality
        </div>
        <p className="mt-1 text-xs text-ink-text-muted">What each plan says is done, and whether that's actually proven.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {plans.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <GitCompare className="h-8 w-8 text-ink-text-label text-ink-text-label" aria-hidden="true" />
            <p className="text-sm font-medium text-ink-text-muted">No plans yet</p>
            <p className="text-xs text-ink-text-subtle">Plans with a plan directory show up here once one exists.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((feature) => (
              <PlanRealityCard key={feature.id} feature={feature} onOpen={() => openPlanReality(feature.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── single-plan comprehension page ────────────────────────────────────────────────────────────

function ConcernRow({ concern }: { concern: PlanRealityConcernDTO }) {
  const [expanded, setExpanded] = React.useState(false);
  const badge = realityStateBadge(concern.realityState);
  const num = /^0*(\d+)/.exec(concern.file)?.[1];

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {num && <span className="rounded bg-ink-surface px-1 font-mono text-caption font-semibold tabular-nums text-ink-text0 bg-ink-surface text-ink-text-subtle">{num.padStart(2, '0')}</span>}
        <span className="text-sm font-medium text-ink-text">{concern.title}</span>
        <span className={badge.className}>{badge.label}</span>
        {concern.blocked && <span className={blockedBadge().className}>{blockedBadge().label}</span>}
        {concern.priority && (
          <span className="rounded-full border border-ink-border px-1.5 py-0.5 text-caption text-ink-text0 border-ink-border-2 text-ink-text-subtle">{concern.priority}</span>
        )}
        {concern.complexity && (
          <span className="rounded-full border border-ink-border px-1.5 py-0.5 text-caption text-ink-text0 border-ink-border-2 text-ink-text-subtle">{concern.complexity}</span>
        )}
        <span className="ml-auto whitespace-nowrap text-caption text-ink-text-subtle">
          {concern.status}
          {concern.planeState ? ` · ${concern.planeState}` : ''}
        </span>
      </div>
      {concern.touches.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="rounded text-caption font-medium text-ink-text-subtle hover:text-ink-text-label focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:text-ink-text-label"
          >
            {expanded ? 'Hide' : 'Show'} {concern.touches.length} touched file{concern.touches.length === 1 ? '' : 's'}
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5 pl-1 font-mono text-caption text-ink-text-muted">
              {concern.touches.map((t) => (
                <li key={t} className="truncate">{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ScopeDriftList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="rounded-lg border border-ink-border p-3 border-ink-border">
      <div className="text-caption font-semibold uppercase tracking-widest text-ink-text-subtle">{title}</div>
      {files.length === 0 ? (
        <div className="mt-1 text-xs text-ink-text-subtle">None.</div>
      ) : (
        <ul className="mt-1.5 space-y-0.5 font-mono text-caption text-ink-text-muted">
          {files.map((f) => (
            <li key={f} className="truncate">{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanRealityBody({ reality }: { reality: PlanRealityDTO }) {
  const { rollup, proof } = reality;
  const vBadge = verifiedBadge(proof.verified);
  const rBadge = reachabilityBadge(proof.reachable);
  const driftLabel = scopeDriftLabel(rollup.scopeDrift);
  const planFlowConcerns = React.useMemo(() => toGraphConcerns(reality.concerns), [reality.concerns]);
  const hasDrift = rollup.scopeDrift.plannedNotTouched.length > 0 || rollup.scopeDrift.touchedNotPlanned.length > 0;

  return (
    <div className="space-y-6">
      {/* Header rollup — the at-a-glance verdict */}
      <section className="rounded-xl border border-ink-border bg-white p-5 shadow-sm border-ink-border bg-ink">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-ink-text">{reality.title}</h1>
            {reality.planDir && <div className="mt-0.5 truncate font-mono text-xs text-ink-text-subtle">{reality.planDir}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <span className="rounded-full border border-red-200 px-2 py-0.5 text-red-600 dark:border-red-900 dark:text-red-400">{rollup.blocked} blocked</span>
            <span className="rounded-full border border-amber-200 px-2 py-0.5 text-amber-600 dark:border-amber-900 dark:text-amber-400">{rollup.open} open</span>
            <span className="rounded-full border border-emerald-200 px-2 py-0.5 text-emerald-600 dark:border-emerald-900 dark:text-emerald-400">{rollup.done} done</span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-8">
          <ProgressRing value={rollup.done} total={rollup.totalConcerns} label="Done" tone="brand" />
          <ProgressRing value={rollup.doneProven} total={rollup.done} label="Really done" tone={proofRingTone(rollup)} />
          <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold uppercase tracking-wide text-ink-text-subtle">Scope drift</span>
              <span className="rounded-full border border-ink-border px-2 py-0.5 text-ink-text-label border-ink-border-2 text-ink-text-label">{driftLabel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold uppercase tracking-wide text-ink-text-subtle">Proof</span>
              <span className={vBadge.className}>{vBadge.label}</span>
              <span className={rBadge.className}>{rBadge.label}</span>
              {proof.prUrl && (
                <a href={proof.prUrl} target="_blank" rel="noreferrer" className="text-[color:var(--wf-accent)] hover:underline">
                  PR{proof.prNumber ? ` #${proof.prNumber}` : ''}
                </a>
              )}
            </div>
            {proof.reachableDetail && <div className="text-caption text-ink-text-subtle">{proof.reachableDetail}</div>}
          </div>
        </div>
      </section>

      {/* ① Planned (before) */}
      <section>
        <h2 className="mb-2 text-caption font-semibold uppercase tracking-widest text-ink-text-subtle">① Planned (before)</h2>
        <PanelSection title="Plan flow" className="bg-panel">
          <div className="p-3">
            {planFlowConcerns.length > 0 ? (
              <PlanFlowDiagram concerns={planFlowConcerns} overviewText="" />
            ) : (
              <div className="px-4 py-6 text-center text-sm text-ink-text-muted">No concerns to chart in this plan.</div>
            )}
          </div>
        </PanelSection>
      </section>

      {/* ② Implemented (after) + ③ Proof — unified per-row: the feature proof (above) reflected
          onto each done concern via realityState, never a fabricated per-concern proof. */}
      <section>
        <h2 className="mb-2 text-caption font-semibold uppercase tracking-widest text-ink-text-subtle">② Implemented (after) &amp; ③ Proof</h2>
        <PanelSection title="Concerns" right={`${reality.concerns.length} total`} className="bg-panel">
          <div className="divide-y divide-ink-border divide-ink-border">
            {reality.concerns.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-text-subtle">No concerns tracked in this plan yet.</div>
            ) : (
              reality.concerns.map((c) => <ConcernRow key={c.file} concern={c} />)
            )}
          </div>
        </PanelSection>
      </section>

      {hasDrift && (
        <section className="grid gap-4 sm:grid-cols-2">
          <ScopeDriftList title="Declared, never touched" files={rollup.scopeDrift.plannedNotTouched} />
          <ScopeDriftList title="Touched, never declared" files={rollup.scopeDrift.touchedNotPlanned} />
        </section>
      )}
    </div>
  );
}

function PlanRealityDetail({ featureId }: { featureId: string }) {
  const { features, openPlanReality } = useTaskContext();
  const feature = features.find((f) => f.id === featureId);
  const repo = feature?.repo;
  const [reality, setReality] = React.useState<PlanRealityDTO | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [retryToken, setRetryToken] = React.useState(0);

  React.useEffect(() => {
    if (!repo) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    fetchPlanReality(featureId, repo)
      .then((r) => { if (alive) { setReality(r); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : 'Failed to load.'); setLoading(false); } });
    return () => { alive = false; };
  }, [featureId, repo, retryToken]);

  const backButton = (
    <button
      type="button"
      onClick={() => openPlanReality()}
      className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-ink-text0 hover:bg-ink-surface hover:text-ink-text-label focus-visible:ring-2 focus-visible:ring-amber-500 text-ink-text-subtle dark:hover:bg-ink-surface dark:hover:text-ink-text-body"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> All plans
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex-shrink-0 border-b border-ink-border px-6 py-3 border-ink-border">{backButton}</header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!feature ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-ink-text-muted">Plan not found</p>
            <p className="text-xs text-ink-text-subtle">This feature isn't in the live roster — it may have been archived.</p>
          </div>
        ) : loading ? (
          <div className="space-y-3" aria-label="Loading plan reality">
            <div className="h-32 animate-pulse rounded-xl bg-ink-surface" />
            <div className="h-64 animate-pulse rounded-xl bg-ink-surface" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
            <div className="text-sm font-medium text-red-700 dark:text-red-300">Couldn't load plan reality</div>
            <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
            <button
              type="button"
              onClick={() => setRetryToken((n) => n + 1)}
              className="rounded bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200 focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-red-900/40 dark:text-red-300"
            >
              Try again
            </button>
          </div>
        ) : !reality ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <GitCompare className="h-8 w-8 text-ink-text-label text-ink-text-label" aria-hidden="true" />
            <p className="text-sm font-medium text-ink-text-muted">No plan-reality data yet</p>
            <p className="text-xs text-ink-text-subtle">This plan hasn't been reconciled against a proof or diff yet.</p>
          </div>
        ) : (
          <PlanRealityBody reality={reality} />
        )}
      </div>
    </div>
  );
}

/** The standalone, deep-linkable "plan vs reality" screen — mounted for `view === 'plan-reality'`
 *  (App.tsx). Routes between the plans index and one plan's comprehension page purely off
 *  `planRealityFeatureId` (TaskContext), which the `#/plan-reality[/:featureId]` hash keeps in
 *  sync (see `openPlanReality`/`closePlanReality`, mirroring the `review` screen's own pattern). */
export function PlanRealityView() {
  const { planRealityFeatureId } = useTaskContext();
  return planRealityFeatureId ? <PlanRealityDetail featureId={planRealityFeatureId} /> : <PlanRealityIndex />;
}

/** The compact strip TaskDetail embeds when its feature has a `planDir` — the two rings plus the
 *  proof verdict/reachability badges, linking into the standalone screen for the same feature.
 *  Renders nothing (not an error) when the feature has no plan-reality data yet — a 404 there is
 *  a normal, common state (most features never had `plan-reality.ts` run against them). */
export function PlanRealityStrip({ featureId, repo }: { featureId: string; repo: string }) {
  const { openPlanReality } = useTaskContext();
  const [reality, setReality] = React.useState<PlanRealityDTO | null | undefined>(undefined);

  React.useEffect(() => {
    let alive = true;
    fetchPlanReality(featureId, repo)
      .then((r) => { if (alive) setReality(r); })
      .catch(() => { if (alive) setReality(null); });
    return () => { alive = false; };
  }, [featureId, repo]);

  if (reality === undefined) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-ink-border bg-ink p-3 border-ink-border bg-panel/40" aria-label="Loading plan reality">
        <div className="h-10 w-10 animate-pulse rounded-full bg-ink-border bg-ink-surface" />
        <div className="h-10 w-10 animate-pulse rounded-full bg-ink-border bg-ink-surface" />
        <span className="text-xs text-ink-text-subtle">Loading plan reality…</span>
      </div>
    );
  }
  if (!reality) return null;

  const vBadge = verifiedBadge(reality.proof.verified);
  const rBadge = reachabilityBadge(reality.proof.reachable);

  return (
    <button
      type="button"
      onClick={() => openPlanReality(featureId)}
      className="flex w-full items-center gap-4 rounded-lg border border-ink-border bg-ink p-3 text-left transition-colors hover:border-ink-border-2 focus-visible:ring-2 focus-visible:ring-amber-500 border-ink-border bg-panel/40 dark:hover:border-ink-border-2"
      title="Open plan vs reality"
    >
      <ProgressRing value={reality.rollup.done} total={reality.rollup.totalConcerns} label="done" size={44} strokeWidth={5} />
      <ProgressRing value={reality.rollup.doneProven} total={reality.rollup.done} label="proven" tone={proofRingTone(reality.rollup)} size={44} strokeWidth={5} />
      <div className="min-w-0 flex-1">
        <div className="text-caption font-semibold uppercase tracking-widest text-ink-text-subtle">Plan vs reality</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className={vBadge.className}>{vBadge.label}</span>
          <span className={rBadge.className}>{rBadge.label}</span>
        </div>
      </div>
      <ArrowLeft className="h-3.5 w-3.5 rotate-180 flex-shrink-0 text-ink-text-subtle" aria-hidden="true" />
    </button>
  );
}
