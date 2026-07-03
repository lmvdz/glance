import React from 'react';
import { Boxes, CheckCircle2, DownloadCloud, Play, ShieldAlert, AlertOctagon } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { VerdictBadge, Callout } from './ui';
import { summarizeCapabilities, type PackHealth, type PackStatus } from '../lib/capabilityStatus';

const HEALTH: Record<PackHealth, { label: string; badge: string; border: string }> = {
  active: { label: 'Active', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', border: 'border-l-emerald-500' },
  broken: { label: 'Broken', badge: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', border: 'border-l-red-500' },
  pending: { label: 'Pending', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', border: 'border-l-amber-500' },
  idle: { label: 'Disabled', badge: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', border: 'border-l-gray-400' },
  available: { label: 'Available', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', border: 'border-l-blue-400' },
};

/**
 * One pack card. State (active / broken / pending / disabled / available) is the
 * hero — a colored left border + a badge + a plain-English detail line — and the
 * tool/skill/workflow counts are demoted to one quiet trailing line.
 */
export const CapabilityPackCard: React.FC<{
  status: PackStatus;
  onInstall: (packId: string) => void;
  onToggle: (installId: string, enabled: boolean) => void;
  onRun: (installId: string, key: string) => void;
}> = ({ status, onInstall, onToggle, onRun }) => {
  const { pack, install, health, detail, runnable, toolCount, skillCount, workflowCount } = status;
  const enabled = install?.state === 'enabled';
  const meta = HEALTH[health];
  const counts = [
    toolCount && `${toolCount} tool${toolCount === 1 ? '' : 's'}`,
    skillCount && `${skillCount} skill${skillCount === 1 ? '' : 's'}`,
    workflowCount && `${workflowCount} workflow${workflowCount === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ') || 'empty pack';
  return (
    <article className={`rounded-2xl border border-l-4 ${meta.border} border-gray-200 dark:border-gray-800 bg-[#fbfbfc] dark:bg-gray-900/70 p-5 shadow-sm`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${meta.badge}`}>{meta.label}</span>
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">{pack.framework}</span>
            <span className="text-[10px] text-gray-400 font-mono">{pack.version}</span>
          </div>
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">{pack.title}</h3>
          <p className={`mt-1 text-sm font-medium ${health === 'broken' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-300'}`}>{detail}</p>
          {pack.description && <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 line-clamp-2">{pack.description}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {!install && <button onClick={() => onInstall(pack.id)} className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs hover:bg-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500">Install</button>}
          {install && <button onClick={() => onToggle(install.id, !enabled)} className="px-3 py-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs hover:opacity-90 focus-visible:ring-2 focus-visible:ring-amber-500">{enabled ? 'Disable' : 'Enable'}</button>}
          {install && runnable && <button onClick={() => onRun(install.id, runnable.key)} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs flex items-center gap-1 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-amber-500"><Play className="w-3 h-3" /> Run</button>}
          {health === 'active' && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> live</span>}
        </div>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">{counts}</span>
      </div>
    </article>
  );
};

export const CapabilityPanel = () => {
  const { capabilities, publicCatalog, importCatalogCapability, installCapability, setCapabilityEnabled, runCapability } = useTaskContext();
  const summary = summarizeCapabilities(capabilities.packs, capabilities.installs);
  const importedSlugs = new Set(capabilities.packs.map((pack) => `${pack.slug}@${pack.version}`));

  // Only show count chips that are non-zero, in attention order.
  const allChips: { label: string; n: number; health: PackHealth }[] = [
    { label: 'broken', n: summary.broken, health: 'broken' },
    { label: 'active', n: summary.active, health: 'active' },
    { label: 'pending', n: summary.pending, health: 'pending' },
    { label: 'disabled', n: summary.idle, health: 'idle' },
    { label: 'available', n: summary.available, health: 'available' },
  ];
  const chips = allChips.filter((c) => c.n > 0);

  return (
    <main className="flex-1 overflow-y-auto bg-white dark:bg-gray-950 p-8 transition-colors duration-200">
      <div className="max-w-6xl mx-auto">
        {/* ── verdict-first header ── */}
        <div className="mb-6">
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-500 font-semibold mb-2">Capability registry</div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Installed agent recipes</h1>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <VerdictBadge verdict={summary.verdict}>{summary.headline}</VerdictBadge>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {chips.map((c) => (
                <span key={c.label} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${HEALTH[c.health].badge}`}>
                  {c.n} {c.label}
                </span>
              ))}
              {chips.length === 0 && <span className="text-gray-400">no packs imported</span>}
            </div>
          </div>
        </div>

        {/* ── danger surfaces itself: broken packs lead ── */}
        {summary.brokenPacks.length > 0 && (
          <div className="mb-6">
            <Callout
              tone="critical"
              title={`${summary.brokenPacks.length} pack${summary.brokenPacks.length === 1 ? '' : 's'} won't run — enabled but not actually bound`}
            >
              <ul className="mt-1 space-y-1">
                {summary.brokenPacks.map((s) => (
                  <li key={s.pack.id} className="flex items-center gap-2">
                    <AlertOctagon className="h-3 w-3 flex-shrink-0 text-red-500" aria-hidden="true" />
                    <span className="font-medium text-gray-800 dark:text-gray-200">{s.pack.title}</span>
                    <span className="text-gray-500 dark:text-gray-400">— {s.detail}</span>
                  </li>
                ))}
              </ul>
            </Callout>
          </div>
        )}

        {capabilities.packs.length === 0 && (
          <div className="border border-dashed border-gray-300 dark:border-gray-800 rounded-2xl p-8 text-center text-gray-500 dark:text-gray-400 mb-8">
            <ShieldAlert className="w-8 h-8 mx-auto mb-3 text-gray-400" />
            <div className="font-medium text-gray-700 dark:text-gray-200 mb-1">No trusted packs imported yet.</div>
            <p className="text-sm">Start with the public catalog below, or import a private manifest through <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1 py-0.5 rounded">POST /api/capability-sources</code>.</p>
          </div>
        )}

        {/* ── trusted packs, sorted attention-first, state as the hero ── */}
        {summary.packs.length > 0 && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Trusted packs</h2>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {summary.packs.map((s) => (
                <CapabilityPackCard key={s.pack.id} status={s} onInstall={installCapability} onToggle={setCapabilityEnabled} onRun={runCapability} />
              ))}
            </div>
          </section>
        )}

        {/* ── public catalog (secondary: discovery, not status) ── */}
        {publicCatalog.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Public catalog</h2>
              <span className="text-xs text-gray-400">Importing records trust; installing still requires approval.</span>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {publicCatalog.map((entry) => {
                const imported = importedSlugs.has(`${entry.slug}@${entry.version}`);
                return (
                  <article key={entry.id} className="rounded-2xl border border-amber-100 dark:border-amber-950 bg-amber-50/40 dark:bg-amber-950/20 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">{entry.framework}</span>
                          <span className="text-[10px] text-gray-400 font-mono">{entry.version}</span>
                        </div>
                        <h3 className="font-semibold text-gray-900 dark:text-gray-100">{entry.title}</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{entry.description}</p>
                      </div>
                      <button disabled={imported} onClick={() => importCatalogCapability(entry.id)} className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-amber-500 ${imported ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-500 text-white hover:bg-amber-600'}`}>
                        {imported ? <CheckCircle2 className="w-3 h-3" /> : <DownloadCloud className="w-3 h-3" />}{imported ? 'Imported' : 'Import'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </main>
  );
};
