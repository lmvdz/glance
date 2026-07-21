/**
 * EpisodesCard — the weekly episode briefs, finally visible (Daily view).
 *
 * The daemon writes a full markdown episode brief every week by default (GLANCE_EPISODE,
 * src/squad-manager.ts) — but the only reader was the voice debrief lane, so for anyone not on a
 * voice call the briefs might as well not exist. This card lists the metas newest-first and lazily
 * fetches one brief's full markdown on expand (the list payload stays light; `fetchEpisode` needs
 * the meta's repo because an isoWeek id is only unique per repo).
 *
 * The meta LIST is a prop (DailyPanel owns the poll, Promise.allSettled with its siblings); the
 * per-episode expand owns its own on-demand fetch. Markdown is rendered, never executed — it embeds
 * digest excerpts from agent runs.
 */

import React, { useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { BookOpenText, ChevronRight } from 'lucide-react';
import { fetchEpisode, type EpisodeMetaDTO } from '../lib/api';
import { SectionCard } from './ui';
import { relativeAge } from './ui/time';

const MARKDOWN_CLASS = 'prose prose-sm max-w-none dark:prose-invert prose-pre:text-[11px] prose-headings:text-sm';

/** One episode row: meta line, expandable to the full brief. Fetches the markdown once, on first
 *  expand; a fetch failure renders inline and retries on the next toggle (no dead-end state). */
export const EpisodeRow: React.FC<{ meta: EpisodeMetaDTO; now?: number }> = ({ meta, now }) => {
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState('');

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && markdown === null) {
      try {
        const full = await fetchEpisode(meta.repo, meta.id);
        setMarkdown(full.markdown);
        setError('');
      } catch {
        setError('Could not fetch this episode from the daemon.');
      }
    }
  }, [open, markdown, meta.repo, meta.id]);

  const age = relativeAge(meta.generatedAt, now);
  return (
    <li className="border-b border-gray-100 last:border-b-0 dark:border-gray-800/60">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:hover:bg-gray-800/60"
      >
        <ChevronRight
          className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-200">{meta.isoWeek}</span>
            {age && (
              <span className="text-[11px] text-gray-400" title={new Date(meta.generatedAt).toISOString()}>
                {age} ago
              </span>
            )}
            <span className="text-[11px] text-gray-400">{meta.digestCount} digests</span>
            {meta.hasStaleAnswers && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                stale answers
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">{meta.excerpt}</span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pl-10">
          {error ? (
            <div role="alert" className="text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : markdown === null ? (
            <div className="h-16 animate-pulse rounded-md bg-gray-100 dark:bg-gray-800" aria-label="Loading episode" />
          ) : (
            <div className={`overflow-x-auto ${MARKDOWN_CLASS}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{markdown}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </li>
  );
};

export const EpisodesCard: React.FC<{
  episodes: EpisodeMetaDTO[];
  loaded: boolean;
  error?: string;
  now?: number;
}> = ({ episodes, loaded, error, now }) => (
  <SectionCard
    title="Weekly episodes"
    right={episodes.length > 0 ? <span className="font-mono text-[11px]">{episodes.length}</span> : undefined}
  >
    {!loaded ? (
      <div className="space-y-2 p-4" aria-label="Loading weekly episodes">
        {[1, 2].map((n) => (
          <div key={n} className="h-10 animate-pulse rounded-md bg-gray-100 dark:bg-gray-800" />
        ))}
      </div>
    ) : error ? (
      <div role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    ) : episodes.length === 0 ? (
      <div className="px-4 py-8 text-center">
        <BookOpenText className="mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-gray-600" aria-hidden="true" />
        <div className="text-sm font-medium text-gray-600 dark:text-gray-300">No episodes yet</div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The daemon writes one brief per week of fleet activity — the first appears after a week with digests.
        </p>
      </div>
    ) : (
      <ul>
        {episodes.map((m) => (
          <EpisodeRow key={`${m.repo}:${m.id}`} meta={m} now={now} />
        ))}
      </ul>
    )}
  </SectionCard>
);
