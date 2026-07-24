import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleDot, GitMerge, Hash, Reply, ShieldAlert } from 'lucide-react';
import type { ChannelEntry } from '../../lib/dto';
import { buildChannelThreadViews, type ChannelCardTone, type ChannelCardView } from '../../lib/channelTimeline';
import { hubHref } from '../../lib/router';
import { channelScrollAfterRowsChange, channelScrollAfterUserScroll, initialChannelScrollState, type ChannelScrollState } from '../../lib/channelScroll';
import { GateVerdictCard } from './GateVerdictCard';

const toneClass: Record<ChannelCardTone, string> = {
  neutral: 'border-zinc-800 bg-[#0c0c0e] text-zinc-200',
  info: 'border-sky-400/25 bg-sky-400/7 text-zinc-100',
  warning: 'border-amber-400/35 bg-amber-400/10 text-amber-50',
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-50',
  destructive: 'border-red-400/35 bg-red-400/10 text-red-50',
};

const iconClass: Record<ChannelCardView['kind'], typeof ShieldAlert> = {
  message: CircleDot,
  'needs-you': ShieldAlert,
  'gate-verdict': CheckCircle2,
  'land-merge': GitMerge,
  'mention-steer': CircleDot,
  'mention-confirm-required': ShieldAlert,
  'mention-steer-failed': AlertCircle,
  'spawn-proposal': CircleDot,
  'unknown-event': CircleDot,
};

function LoadingTimeline() {
  return (
    <div className="space-y-3 p-4" aria-label="Loading channel">
      {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-14 rounded-xl border border-zinc-800 bg-zinc-900/60 skeleton" />)}
    </div>
  );
}

function EmptyTimeline() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="relative">
        <div className="absolute inset-0 -rotate-3 rounded-2xl border border-zinc-800 bg-zinc-950" aria-hidden />
        <div className="absolute inset-0 rotate-3 rounded-2xl border border-zinc-800 bg-zinc-950" aria-hidden />
        <div className="relative max-w-sm rounded-2xl border border-zinc-800 bg-[#0c0c0e] p-6">
          <Hash className="mx-auto mb-3 h-6 w-6 text-amber-300" aria-hidden />
          <h2 className="text-sm font-semibold text-zinc-100">No entries yet.</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Fleet cards and operator messages will land here as the room wakes up.</p>
        </div>
      </div>
    </div>
  );
}

const ChannelTimelineRow = memo(function ChannelTimelineRow({ view, onReply }: { view: ChannelCardView; onReply?: (entry: ChannelEntry) => void }) {
  const user = view.entry.kind === 'user';
  const Icon = iconClass[view.kind];
  if (view.kind === 'message') {
    return (
      <li data-entry-id={view.id} className={`group flex ${user ? 'justify-end' : 'justify-start'}`}>
        <article className={`max-w-[80%] rounded-2xl border px-3 py-2 text-sm leading-6 transition-colors duration-200 ${user ? 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-750' : toneClass.neutral}`}>
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-zinc-500 opacity-80 transition-opacity duration-200 group-hover:opacity-100">
            <span>{view.authorLabel}</span>
            <span className="tabular-nums">#{view.entry.seq}</span>
          </div>
          {view.replyContext ? (
            <a href={hubHref(view.replyContext.channelId, view.replyContext.id)} className="mb-2 block rounded-xl border border-zinc-700/70 bg-black/20 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900">
              <span className="block text-[10px] uppercase tracking-[0.12em] text-zinc-500">Reply to {view.replyContext.authorLabel}</span>
              <span className="line-clamp-2">{view.replyContext.body}</span>
            </a>
          ) : null}
          <p className="whitespace-pre-wrap break-words">{view.body}</p>
          <div className="mt-2 flex items-center gap-2">
            {onReply ? (
              <button
                type="button"
                onClick={() => onReply(view.entry)}
                className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-700/50 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
              >
                <Reply className="h-3.5 w-3.5" aria-hidden />
                Reply
              </button>
            ) : null}
            {view.repliedBy ? <span className="text-[11px] text-zinc-500">{view.repliedBy} {view.repliedBy === 1 ? 'reply' : 'replies'}</span> : null}
          </div>
        </article>
      </li>
    );
  }
  if (view.kind === 'gate-verdict') return <GateVerdictCard view={view} />;
  return (
    <li data-entry-id={view.id} className="group flex justify-start">
      <article className={`w-full max-w-2xl rounded-2xl border px-3 py-3 text-sm shadow-sm transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 ${toneClass[view.tone]}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-current/20 bg-black/20">
            <Icon className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {view.eyebrow ? <span className="text-[10px] font-medium uppercase tracking-[0.14em] opacity-60">{view.eyebrow}</span> : null}
              <span className="rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] opacity-80">{view.kind}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] opacity-55">{view.authorLabel}</span>
              <span className="text-[10px] tabular-nums opacity-50">#{view.entry.seq}</span>
            </div>
            <h3 className="mt-1 text-sm font-semibold tracking-tight">{view.title}</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 opacity-85">{view.body}</p>
            {view.pinned.length ? (
              <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {view.pinned.map((item) => (
                  <div key={item.label} className="rounded-lg border border-current/10 bg-black/10 px-2 py-1.5">
                    <dt className="text-[10px] uppercase tracking-[0.12em] opacity-50">{item.label}</dt>
                    <dd className="mt-0.5 truncate text-xs font-medium">{item.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {view.detail ? <p className="mt-2 text-xs leading-5 opacity-60">{view.detail}</p> : null}
          </div>
        </div>
      </article>
    </li>
  );
});

export function ChannelTimeline({ entries, loading, error, anchorEntryId, onReply }: { entries: ChannelEntry[]; loading: boolean; error: string; anchorEntryId?: string; onReply?: (entry: ChannelEntry) => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollStateRef = useRef<ChannelScrollState>(initialChannelScrollState());
  const [stableRows, setStableRows] = useState<ChannelCardView[]>([]);
  const views = useMemo(() => buildChannelThreadViews(entries), [entries]);

  useEffect(() => {
    setStableRows((previous) => {
      const byId = new Map(previous.map((row) => [row.id, row]));
      return views.map((row) => {
        const prev = byId.get(row.id);
        return prev && prev.entry === row.entry && prev.kind === row.kind && prev.body === row.body && prev.title === row.title ? prev : row;
      });
    });
  }, [views]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || loading || error) return;
    const anchor = scrollStateRef.current.anchorEntryId ? scroller.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(scrollStateRef.current.anchorEntryId)}"]`) : undefined;
    const result = channelScrollAfterRowsChange(scrollStateRef.current, { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }, anchor?.offsetTop);
    scrollStateRef.current = result.state;
    if (result.scrollTop !== undefined) scroller.scrollTop = result.scrollTop;
  }, [stableRows, loading, error]);
  useEffect(() => {
    if (!anchorEntryId) return;
    scrollStateRef.current = { mode: 'anchoring-new-turn', anchorEntryId, reservedTrailingPx: Math.max(0, (scrollerRef.current?.clientHeight ?? 0) - 32) };
    requestAnimationFrame(() => {
      scrollerRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(anchorEntryId)}"]`)?.scrollIntoView({ block: 'center' });
    });
  }, [anchorEntryId]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scrollStateRef.current = channelScrollAfterUserScroll(scrollStateRef.current, { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight });
  };

  return (
    <div ref={scrollerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-[#09090a]" data-scroll-mode={scrollStateRef.current.mode}>
      {loading ? <LoadingTimeline /> : error ? <div className="m-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert"><AlertCircle className="h-4 w-4" aria-hidden /> {error}</div> : stableRows.length === 0 ? <EmptyTimeline /> : <ol className="space-y-3 p-4 pb-10">{stableRows.map((view) => <ChannelTimelineRow key={view.id} view={view} onReply={onReply} />)}</ol>}
    </div>
  );
}
