import React from 'react';
import { AlertTriangle, ArrowLeft, Boxes, CheckCircle2, FileText, GitBranch, Layers3, Palette, Sparkles } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { fetchPlanBrief } from '../lib/api';
import type { FeatureDTO, PlanBriefDTO } from '../lib/dto';
import { buildPlanBriefHash, planBriefFeatures, planBriefNameFromDir } from '../lib/plan-brief-route';

const toneByStatus = (status: string, open: boolean): string => {
  if (!open) return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/40 dark:text-emerald-300';
  if (/block|hold|waiting|stuck/i.test(status)) return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/80 dark:bg-red-950/40 dark:text-red-300';
  return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/40 dark:text-amber-300';
};

function PlanBriefIndexCard({ feature, onOpen }: { feature: FeatureDTO; onOpen: () => void }) {
  const name = planBriefNameFromDir(feature.planDir) ?? feature.id;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-40 flex-col items-start justify-between rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition-colors hover:border-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-amber-800"
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300">
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Brief
      </span>
      <div className="min-w-0 space-y-1">
        <div className="truncate text-sm font-semibold text-gray-950 group-hover:text-amber-700 dark:text-gray-100 dark:group-hover:text-amber-300">{feature.title}</div>
        <div className="truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">plans/{name}</div>
      </div>
      <span className="text-xs text-gray-500 dark:text-gray-400">Open the human explainer: outcome, diagram, gates, scope.</span>
    </button>
  );
}

function Metric({ label, value, tone = 'text-gray-950 dark:text-gray-100' }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white/80 p-4 dark:border-gray-800 dark:bg-gray-950/80">
      <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}

function PlanBriefLoading() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="h-48 animate-pulse rounded-3xl bg-gray-100 dark:bg-gray-900" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="h-48 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-900" />
          <div className="h-48 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-900" />
          <div className="h-48 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-900" />
        </div>
      </div>
    </div>
  );
}

function PlanBriefBody({ brief }: { brief: PlanBriefDTO }) {
  const maxPhase = Math.max(1, ...brief.concerns.map((c) => c.phase));
  const statusEntries = Object.entries(brief.status.byStatus).sort((a, b) => b[1] - a[1]);
  return (
    <div className="h-full overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.16),transparent_34rem)] p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="overflow-hidden rounded-3xl border border-gray-200 bg-gray-950 text-white shadow-sm dark:border-gray-800">
          <div className="grid gap-8 p-6 md:grid-cols-[1.25fr_0.75fr] md:p-8">
            <div className="space-y-5">
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-200">
                <Palette className="h-3.5 w-3.5" aria-hidden="true" /> Human comprehension brief
              </div>
              <div className="space-y-2">
                <h1 className="max-w-4xl text-3xl font-semibold tracking-tight md:text-5xl">{brief.title}</h1>
                <p className="max-w-3xl text-sm leading-6 text-gray-300 md:text-base">{brief.outcome}</p>
              </div>
              <div className="flex flex-wrap gap-2 font-mono text-[11px] text-gray-300">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{brief.planDir}</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{brief.status.total} concern{brief.status.total === 1 ? '' : 's'}</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">updated {new Date(brief.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400">Live status split</div>
              <div className="mt-4 space-y-3">
                {statusEntries.map(([status, count]) => (
                  <div key={status} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs"><span>{status}</span><span className="font-mono">{count}</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-amber-300" style={{ width: `${brief.status.total ? Math.max(6, (count / brief.status.total) * 100) : 0}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Done" value={brief.status.done} tone="text-emerald-600 dark:text-emerald-300" />
          <Metric label="Open" value={brief.status.open} tone="text-amber-600 dark:text-amber-300" />
          <Metric label="Blocked" value={brief.status.blocked} tone="text-red-600 dark:text-red-300" />
          <Metric label="Batches" value={maxPhase} />
        </div>

        {brief.dependencyIssues.length > 0 && (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900/80 dark:bg-red-950/30 dark:text-red-200">
            <div className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" /> Dependency issues</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {brief.dependencyIssues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          </section>
        )}

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950 dark:text-gray-100"><GitBranch className="h-4 w-4 text-amber-600" aria-hidden="true" /> What changes, in dependency order</div>
            <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: `repeat(${maxPhase}, minmax(10rem, 1fr))` }}>
              {Array.from({ length: maxPhase }, (_, index) => index + 1).map((phase) => (
                <div key={phase} className="min-w-0 space-y-3 rounded-2xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900/50">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">Phase {phase}</div>
                  {brief.concerns.filter((c) => c.phase === phase).map((concern) => (
                    <div key={concern.file} className={`rounded-xl border p-3 ${toneByStatus(concern.status, concern.open)}`}>
                      <div className="text-xs font-semibold leading-5">{concern.title}</div>
                      <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10px] opacity-80"><span>{concern.status}</span>{concern.complexity && <span>· {concern.complexity}</span>}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950 dark:text-gray-100"><Layers3 className="h-4 w-4 text-amber-600" aria-hidden="true" /> Batch timeline with gates</div>
            <ol className="mt-5 space-y-4">
              {brief.timeline.map((item) => (
                <li key={item.phase} className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-950 text-xs font-semibold text-white dark:bg-gray-100 dark:text-gray-950">{item.phase}</span>
                  <div className="min-w-0 border-b border-gray-100 pb-4 last:border-0 dark:border-gray-800">
                    <div className="text-sm font-semibold text-gray-950 dark:text-gray-100">{item.title}</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Gate: {item.gate}</div>
                    <div className="mt-2 flex flex-wrap gap-1 font-mono text-[10px] text-gray-500 dark:text-gray-400">
                      {item.concernFiles.map((file) => <span key={file} className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-900">{file}</span>)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950 dark:text-gray-100"><CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" /> Decisions</div>
            {brief.decisions.length === 0 ? <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No explicit decisions captured yet.</p> : (
              <ul className="mt-3 space-y-2 text-xs leading-5 text-gray-600 dark:text-gray-300">
                {brief.decisions.map((decision) => <li key={`${decision.source}:${decision.text}`} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-900/60">{decision.text}</li>)}
              </ul>
            )}
          </div>
          <div className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950 dark:text-gray-100"><Boxes className="h-4 w-4 text-amber-600" aria-hidden="true" /> Out of scope</div>
            {brief.outOfScope.length === 0 ? <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No explicit non-goals listed.</p> : (
              <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-5 text-gray-600 dark:text-gray-300">
                {brief.outOfScope.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </div>
          <div className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-950 dark:text-gray-100"><FileText className="h-4 w-4 text-amber-600" aria-hidden="true" /> Touched surface</div>
            {brief.touches.length === 0 ? <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">No TOUCHES entries yet.</p> : (
              <ul className="mt-3 space-y-1 font-mono text-[11px] text-gray-600 dark:text-gray-300">
                {brief.touches.slice(0, 12).map((file) => <li key={file} className="truncate rounded bg-gray-50 px-2 py-1 dark:bg-gray-900/60">{file}</li>)}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function PlanBriefIndex() {
  const { features, openPlanBrief } = useTaskContext();
  const plans = React.useMemo(() => planBriefFeatures(features), [features]);
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex-shrink-0 border-b border-gray-200 px-6 py-4 dark:border-gray-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100"><Sparkles className="h-4 w-4 text-amber-600" aria-hidden="true" /> Plan briefs</div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Styled HTML explainers generated from plans/&lt;name&gt; directories.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {plans.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Sparkles className="h-8 w-8 text-gray-300 dark:text-gray-700" aria-hidden="true" />
            <p className="text-sm font-medium text-gray-600 dark:text-gray-300">No plan briefs yet</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Create a plans/&lt;name&gt; directory and its explainer appears here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((feature) => <PlanBriefIndexCard key={feature.id} feature={feature} onOpen={() => openPlanBrief(planBriefNameFromDir(feature.planDir) ?? feature.id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export function PlanBriefView() {
  const { currentProject, planBriefName, closePlanBrief } = useTaskContext();
  const [brief, setBrief] = React.useState<PlanBriefDTO | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!planBriefName) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchPlanBrief(planBriefName, currentProject?.id)
      .then((value) => { if (alive) setBrief(value); })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Could not load plan brief.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [planBriefName, currentProject?.id]);

  if (!planBriefName) return <PlanBriefIndex />;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-gray-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/80">
        <button type="button" onClick={closePlanBrief} className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-900" aria-label="Back to plan briefs">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-950 dark:text-gray-100">Plan brief</div>
          <a className="truncate font-mono text-[11px] text-amber-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300" href={buildPlanBriefHash({ name: planBriefName })}>#/plans/{planBriefName}/brief</a>
        </div>
      </header>
      {loading ? <PlanBriefLoading /> : error ? (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-red-200 bg-red-50 p-5 text-red-800 dark:border-red-900/80 dark:bg-red-950/30 dark:text-red-200">
            <div className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" /> Could not load this plan brief</div>
            <p className="mt-2 text-xs leading-5">{error}</p>
            <button type="button" onClick={() => setError(null)} className="mt-4 min-h-10 rounded-md bg-red-700 px-3 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:bg-red-600">Dismiss</button>
          </div>
        </div>
      ) : brief ? <PlanBriefBody brief={brief} /> : null}
    </div>
  );
}
