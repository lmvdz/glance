import React from 'react';
import { Boxes, CheckCircle2, DownloadCloud, Play, ShieldAlert } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { enabledCapabilityCount, installForPack } from '../lib/capability-view';

export const CapabilityPanel = () => {
  const { capabilities, publicCatalog, importCatalogCapability, installCapability, setCapabilityEnabled, runCapability } = useTaskContext();
  const enabledCount = enabledCapabilityCount(capabilities.installs);
  const importedSlugs = new Set(capabilities.packs.map((pack) => `${pack.slug}@${pack.version}`));

  return (
    <main className="flex-1 overflow-y-auto bg-white dark:bg-gray-950 p-8 transition-colors duration-200">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="text-[11px] uppercase tracking-[0.2em] text-blue-500 font-semibold mb-2">Capability registry</div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Installed agent recipes</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Manifest packs become approved profiles, workflows, tools, and federation metadata.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <Boxes className="w-4 h-4" /> {capabilities.packs.length} packs · {enabledCount} enabled
          </div>
        </div>

        {capabilities.packs.length === 0 && (
          <div className="border border-dashed border-gray-300 dark:border-gray-800 rounded-2xl p-8 text-center text-gray-500 dark:text-gray-400 mb-8">
            <ShieldAlert className="w-8 h-8 mx-auto mb-3 text-gray-400" />
            <div className="font-medium text-gray-700 dark:text-gray-200 mb-1">No trusted packs imported yet.</div>
            <p className="text-sm">Start with the public catalog below, or import a private manifest through <code className="text-xs bg-gray-100 dark:bg-gray-900 px-1 py-0.5 rounded">POST /api/capability-sources</code>.</p>
          </div>
        )}

        {publicCatalog.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Public catalog</h2>
              <span className="text-xs text-gray-400">Importing records trust; installing still requires approval.</span>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {publicCatalog.map((entry) => {
                const imported = importedSlugs.has(`${entry.slug}@${entry.version}`);
                return (
                  <article key={entry.id} className="rounded-2xl border border-blue-100 dark:border-blue-950 bg-blue-50/40 dark:bg-blue-950/20 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">{entry.framework}</span>
                          <span className="text-[10px] text-gray-400 font-mono">{entry.version}</span>
                        </div>
                        <h3 className="font-semibold text-gray-900 dark:text-gray-100">{entry.title}</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{entry.description}</p>
                      </div>
                      <button disabled={imported} onClick={() => importCatalogCapability(entry.id)} className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-blue-500 ${imported ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                        {imported ? <CheckCircle2 className="w-3 h-3" /> : <DownloadCloud className="w-3 h-3" />}{imported ? 'Imported' : 'Import'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {capabilities.packs.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Trusted packs</h2>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {capabilities.packs.map((pack) => {
                const install = installForPack(pack, capabilities.installs);
                const enabled = install?.state === 'enabled';
                const runnable = install?.bindings.find((binding) => binding.enabled && (binding.type === 'profile' || binding.type === 'workflow' || binding.type === 'driver'));
                return (
                  <article key={pack.id} className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-[#fbfbfc] dark:bg-gray-900/70 p-5 shadow-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">{pack.framework}</span>
                          <span className="text-[10px] text-gray-400 font-mono">{pack.version}</span>
                        </div>
                        <h2 className="font-semibold text-gray-900 dark:text-gray-100">{pack.title}</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{pack.description || 'No description provided.'}</p>
                      </div>
                      <div className={`text-[10px] px-2 py-1 rounded-full ${enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                        {install?.state ?? 'not installed'}
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <div className="rounded-xl bg-white dark:bg-gray-950 border border-gray-100 dark:border-gray-800 p-3"><b className="block text-gray-900 dark:text-gray-200">{pack.tools.length}</b> tools</div>
                      <div className="rounded-xl bg-white dark:bg-gray-950 border border-gray-100 dark:border-gray-800 p-3"><b className="block text-gray-900 dark:text-gray-200">{pack.skills.length}</b> skills</div>
                      <div className="rounded-xl bg-white dark:bg-gray-950 border border-gray-100 dark:border-gray-800 p-3"><b className="block text-gray-900 dark:text-gray-200">{pack.workflows.length}</b> workflows</div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {!install && <button onClick={() => installCapability(pack.id)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500">Install</button>}
                      {install && <button onClick={() => setCapabilityEnabled(install.id, !enabled)} className="px-3 py-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs hover:opacity-90 focus-visible:ring-2 focus-visible:ring-blue-500">{enabled ? 'Disable' : 'Enable'}</button>}
                      {install && runnable && <button onClick={() => runCapability(install.id, runnable.key)} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs flex items-center gap-1 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500"><Play className="w-3 h-3" /> Run</button>}
                      {enabled && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> bound to runtime</span>}
                    </div>

                    <div className="mt-4 text-[10px] text-gray-400 font-mono break-all">sha256:{pack.checksum}</div>
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
