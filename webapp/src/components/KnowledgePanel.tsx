/**
 * KnowledgePanel — the queryable context knowledge base (KB).
 *
 * The daemon already distills everything across plans/agents/receipts into the
 * context fabric; this surfaces it as something you can ASK. Search-first: type a
 * question and get ranked, typed facts (decisions, hot files, prior sessions,
 * peers, latent work, who's editing what). Idle, it shows the KB at a glance.
 *
 * Backed by GET /api/fabric (overview) and GET /api/fabric/search?q= (ranked) —
 * both scoped server-side, so the panel only ever surfaces what you may see.
 * The same search powers agent cold-start (lib/fabric-search buildContextPrimer).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Library, Search, Flame, Lightbulb, Lock, GitCommitHorizontal, Users, Sparkles } from 'lucide-react';
import { apiJson } from '../lib/api';
import { PanelShell, SectionCard, VerdictBadge } from './ui';

type KbType = 'agent' | 'digest' | 'hot-area' | 'scout' | 'lease' | 'decision';

interface KbResult { type: KbType; id: string; title: string; snippet: string; score: number; repo?: string; ref?: string }
interface KbCounts { agents: number; digests: number; hotAreas: number; scout: number; leases: number; decisions: number }
interface KbSearchResponse { query: string; results: KbResult[]; counts: KbCounts }

interface FabricSnapshot {
  agents: { agent: { id: string; name: string; status: string; repo?: string; issue?: { identifier?: string; name?: string } } }[];
  hotAreas: { repo: string; file: string; score: number }[];
  scout: { issue: { identifier?: string; url?: string }; title: string }[];
  leases: { lease: { file: string; session: string; repo: string } }[];
  decisions: { featureTitle: string; text: string; decisionSource?: string }[];
}

const TYPE_META: Record<KbType, { label: string; chip: string; Icon: React.ComponentType<{ className?: string }> }> = {
  decision: { label: 'Decision', chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300', Icon: Lightbulb },
  'hot-area': { label: 'Hot file', chip: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300', Icon: Flame },
  digest: { label: 'Prior session', chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', Icon: GitCommitHorizontal },
  agent: { label: 'Agent', chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', Icon: Users },
  scout: { label: 'Latent work', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', Icon: Sparkles },
  lease: { label: 'Being edited', chip: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300', Icon: Lock },
};

const ResultRow: React.FC<{ r: KbResult }> = ({ r }) => {
  const meta = TYPE_META[r.type];
  return (
    <li className="flex items-start gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-3 last:border-b-0">
      <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.chip}`}>
        <meta.Icon className="h-3 w-3" aria-hidden="true" />
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={r.title}>{r.title}</div>
        <div className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{r.snippet}</div>
        {r.repo && <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400 dark:text-gray-500">{r.repo}</div>}
      </div>
    </li>
  );
};

export const KnowledgePanel: React.FC = () => {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [counts, setCounts] = useState<KbCounts | null>(null);
  const [results, setResults] = useState<KbResult[]>([]);
  const [snapshot, setSnapshot] = useState<FabricSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const reqRef = useRef(0);

  // overview (counts + at-a-glance) — fetched once on mount, refreshed on an interval
  const loadOverview = useCallback(async () => {
    try {
      const [snap, search] = await Promise.all([
        apiJson<FabricSnapshot>('/api/fabric').catch((): null => null),
        apiJson<KbSearchResponse>('/api/fabric/search?q=').catch((): null => null),
      ]);
      setSnapshot(snap);
      if (search) setCounts(search.counts);
      setError('');
    } catch {
      setError('Could not reach the daemon for the knowledge base.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    const iv = setInterval(() => void loadOverview(), 15_000);
    return () => clearInterval(iv);
  }, [loadOverview]);

  // debounce the query
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // run the ranked search whenever the debounced query changes
  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setSearching(false);
      return;
    }
    const id = ++reqRef.current;
    setSearching(true);
    void apiJson<KbSearchResponse>(`/api/fabric/search?q=${encodeURIComponent(debounced)}&topK=30`)
      .then((r) => {
        if (id !== reqRef.current) return;
        setResults(r.results);
        setCounts(r.counts);
      })
      .catch(() => {
        if (id === reqRef.current) setResults([]);
      })
      .finally(() => {
        if (id === reqRef.current) setSearching(false);
      });
  }, [debounced]);

  const total = counts ? counts.agents + counts.digests + counts.hotAreas + counts.scout + counts.leases + counts.decisions : 0;
  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={total > 0 ? 'healthy' : 'warn'}>
        {total > 0 ? `${total} facts indexed` : 'No facts yet'}
      </VerdictBadge>
      {counts && (
        <span className="text-xs text-gray-400">
          {counts.decisions} decisions · {counts.hotAreas} hot files · {counts.digests} sessions · {counts.scout} latent · {counts.agents} agents
        </span>
      )}
    </span>
  );

  return (
    <PanelShell icon={<Library className="h-4 w-4 text-indigo-500" aria-hidden="true" />} title="Knowledge base" subtitle={subtitle}>
      {/* search — the hero */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask the fleet's memory — e.g. “refresh token rotation”, “heat colormap”, src/auth/token.ts"
          aria-label="Search the knowledge base"
          className="w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 py-2.5 pl-10 pr-3 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
        />
      </div>

      {loaded && error && (
        <div role="alert" className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>
      )}

      {/* RESULTS (querying) */}
      {debounced ? (
        <SectionCard title={searching ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'} for “${debounced}”`}>
          {results.length === 0 && !searching ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No facts match. Try a file path, a decision, or a feature name.</div>
          ) : (
            <ul>{results.map((r) => <ResultRow key={r.id} r={r} />)}</ul>
          )}
        </SectionCard>
      ) : (
        /* OVERVIEW (idle) — the KB at a glance */
        loaded && !error && (
          <Overview snapshot={snapshot} />
        )
      )}

      {!loaded && !error && (
        <div className="space-y-3 animate-pulse">{[1, 2, 3].map((n) => <div key={n} className="h-16 rounded-lg bg-gray-100 dark:bg-gray-800" />)}</div>
      )}
    </PanelShell>
  );
};

const Overview: React.FC<{ snapshot: FabricSnapshot | null }> = ({ snapshot }) => {
  const hotAreas = useMemo(() => (snapshot?.hotAreas ?? []).slice(0, 8), [snapshot]);
  const decisions = useMemo(() => (snapshot?.decisions ?? []).slice(0, 8), [snapshot]);
  const scout = useMemo(() => (snapshot?.scout ?? []).slice(0, 6), [snapshot]);
  const leases = useMemo(() => (snapshot?.leases ?? []).slice(0, 6), [snapshot]);

  if (!snapshot || (hotAreas.length + decisions.length + scout.length + leases.length === 0)) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 py-10 text-center">
        <Library className="h-8 w-8 text-gray-300 dark:text-gray-700" aria-hidden="true" />
        <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">The knowledge base is still warming up</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">Decisions, session digests, and hot files appear here as agents do work.</div>
      </div>
    );
  }

  return (
    <>
      {decisions.length > 0 && (
        <SectionCard title={<span className="flex items-center gap-1.5"><Lightbulb className="h-3.5 w-3.5 text-indigo-500" aria-hidden="true" />Decisions on record</span>} right={`${decisions.length}`}>
          <ul>
            {decisions.map((d, i) => (
              <li key={i} className="border-b border-gray-100 dark:border-gray-800 px-4 py-2.5 last:border-b-0">
                <div className="text-sm text-gray-800 dark:text-gray-200">{d.text}</div>
                <div className="mt-0.5 text-[11px] text-gray-400">{d.featureTitle}{d.decisionSource ? ` · ${d.decisionSource}` : ''}</div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {hotAreas.length > 0 && (
        <SectionCard title={<span className="flex items-center gap-1.5"><Flame className="h-3.5 w-3.5 text-orange-500" aria-hidden="true" />Hot files</span>} right={`${hotAreas.length}`}>
          <ul>
            {hotAreas.map((h) => (
              <li key={`${h.repo}:${h.file}`} className="flex items-center justify-between gap-3 border-b border-gray-100 dark:border-gray-800 px-4 py-2 last:border-b-0">
                <span className="truncate font-mono text-xs text-gray-700 dark:text-gray-300" title={h.file}>{h.file}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{h.score.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {scout.length > 0 && (
          <SectionCard title={<span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />Latent work</span>} right={`${scout.length}`}>
            <ul>
              {scout.map((s, i) => (
                <li key={i} className="border-b border-gray-100 dark:border-gray-800 px-4 py-2 text-xs text-gray-700 dark:text-gray-300 last:border-b-0">
                  {s.title}{s.issue.identifier ? <span className="ml-1 font-mono text-[10px] text-gray-400">{s.issue.identifier}</span> : null}
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
        {leases.length > 0 && (
          <SectionCard title={<span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-rose-500" aria-hidden="true" />In flight</span>} right={`${leases.length}`}>
            <ul>
              {leases.map((l, i) => (
                <li key={i} className="flex items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-2 text-xs last:border-b-0">
                  <span className="truncate font-mono text-gray-700 dark:text-gray-300" title={l.lease.file}>{l.lease.file}</span>
                  <span className="shrink-0 text-[11px] text-gray-400">{l.lease.session}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
      </div>
    </>
  );
};
