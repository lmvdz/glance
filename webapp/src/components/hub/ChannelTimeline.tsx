import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, CircleDot, FileText, Flame, GitMerge, Hash, Reply, Rocket, ShieldAlert } from 'lucide-react';
import type { ChannelEntry } from '../../lib/dto';
import { buildChannelThreadViews, doorLabel, groupLifecycleRuns, type ChannelCardTone, type ChannelCardView } from '../../lib/channelTimeline';
import { entryTimeLabel } from '../../lib/hub';
import { hubHref } from '../../lib/router';
import { channelScrollAfterRowsChange, channelScrollAfterUserScroll, initialChannelScrollState, type ChannelScrollState } from '../../lib/channelScroll';
import { GateVerdictCard } from './GateVerdictCard';
import { attachmentIdFromPath, extractAttachedImagePaths, stripAttachedImageMarkers } from '../../lib/spawnProposal';

const toneClass: Record<ChannelCardTone, string> = {
  neutral: 'border-ink-border bg-panel text-ink-text-body',
  info: 'border-sky-400/25 bg-sky-400/7 text-ink-text',
  warning: 'border-amber-400/35 bg-amber-400/10 text-amber-50',
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-50',
  destructive: 'border-red-400/35 bg-red-400/10 text-red-50',
};

const iconClass: Record<ChannelCardView['kind'], typeof ShieldAlert> = {
  message: CircleDot,
  'needs-you': ShieldAlert,
  'gate-verdict': CheckCircle2,
  'land-attempt': GitMerge,
  'land-assessment': ShieldAlert,
  'land-merge': GitMerge,
  'token-burn-snapshot': Flame,
  'mention-steer': CircleDot,
  'mention-confirm-required': ShieldAlert,
  'mention-steer-failed': AlertCircle,
  'spawn-proposal': CircleDot,
  'plan-card': FileText,
  'unit-spawned': Rocket,
  'unit-turn-finished': CheckCircle2,
  'unit-failed': AlertCircle,
  'pr-opened': GitMerge,
  'verification-ran': CheckCircle2,
  'unknown-event': CircleDot,
};

function LoadingTimeline() {
  return (
    <div className="space-y-3 p-4" aria-label="Loading channel">
      {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-14 rounded-xl border border-ink-border bg-ink-surface/60 skeleton" />)}
    </div>
  );
}

function EmptyTimeline() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="relative">
        <div className="absolute inset-0 -rotate-3 rounded-2xl border border-ink-border bg-ink" aria-hidden />
        <div className="absolute inset-0 rotate-3 rounded-2xl border border-ink-border bg-ink" aria-hidden />
        <div className="relative max-w-sm rounded-2xl border border-ink-border bg-panel p-6">
          <Hash className="mx-auto mb-3 h-6 w-6 text-ember" aria-hidden />
          <h2 className="text-sm font-semibold text-ink-text">No entries yet.</h2>
          <p className="mt-1 text-xs leading-5 text-ink-text-muted">Fleet cards and operator messages will land here as the room wakes up.</p>
        </div>
      </div>
    </div>
  );
}
export const ChannelTimelineRow = memo(function ChannelTimelineRow({ view, onReply }: { view: ChannelCardView; onReply?: (entry: ChannelEntry) => void }) {
  const user = view.entry.kind === 'user';
  const Icon = iconClass[view.kind];
  const attachmentIds = extractAttachedImagePaths(view.body)
    .map(attachmentIdFromPath)
    .filter((id): id is string => id !== undefined);
  const visibleBody = stripAttachedImageMarkers(view.body);
  if (view.kind === 'message') {
    return (
      <li data-entry-id={view.id} className={`group flex ${user ? 'justify-end' : 'justify-start'}`}>
        <article className={`max-w-[80%] rounded-2xl border px-3 py-2 text-sm leading-6 transition-colors duration-200 ${user ? 'border-ink-border-2 bg-ink-surface text-ink-text hover:bg-ink-border' : toneClass.neutral}`}>
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-ink-text-muted opacity-80 transition-opacity duration-200 group-hover:opacity-100">
            <span>{view.authorLabel}</span>
            <time dateTime={new Date(view.entry.ts).toISOString()} className="tabular-nums">{entryTimeLabel(view.entry.ts)}</time>
          </div>
          {view.replyContext ? (
            <a href={hubHref(view.replyContext.channelId, view.replyContext.id)} className="mb-2 block rounded-xl border border-ink-border-2 bg-black/20 px-2 py-1.5 text-xs text-ink-text-label hover:text-ink-text-body focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink">
              <span className="block text-[10px] uppercase tracking-[0.12em] text-ink-text-muted">Reply to {view.replyContext.authorLabel}</span>
              <span className="line-clamp-2">{view.replyContext.body}</span>
            </a>
          ) : null}
          {visibleBody ? <p className="whitespace-pre-wrap break-words">{visibleBody}</p> : null}
          {attachmentIds.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2" aria-label={`${attachmentIds.length} attached image${attachmentIds.length === 1 ? '' : 's'}`}>
              {attachmentIds.map((id) => (
                <a
                  key={id}
                  href={`/api/chat-attachments/${id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-xl border border-ink-border-2 bg-ink focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                >
                  <img
                    src={`/api/chat-attachments/${id}`}
                    alt={`Image attached by ${view.authorLabel}`}
                    loading="lazy"
                    className="max-h-80 max-w-full object-contain"
                  />
                </a>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            {onReply ? (
              <button
                type="button"
                onClick={() => onReply(view.entry)}
                className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-ink-text-muted transition-colors hover:bg-ink-surface hover:text-ink-text-body focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
              >
                <Reply className="h-3.5 w-3.5" aria-hidden />
                Reply
              </button>
            ) : null}
            {view.repliedBy ? <span className="text-[11px] text-ink-text-muted">{view.repliedBy} {view.repliedBy === 1 ? 'reply' : 'replies'}</span> : null}
          </div>
        </article>
      </li>
    );
  }
  if (view.kind === 'gate-verdict') return <GateVerdictCard view={view} />;
  return (
    <li data-entry-id={view.id} className="group flex justify-start">
      <article className={`w-full rounded-2xl border px-3 py-3 text-sm shadow-sm transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 ${toneClass[view.tone]}`}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-current/20 bg-black/20">
            <Icon className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {view.eyebrow ? <span className="text-[10px] font-medium uppercase tracking-[0.14em] opacity-60">{view.eyebrow}</span> : null}
              <span className="rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] opacity-80">{view.kind}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] opacity-55">{view.authorLabel}</span>
              <time dateTime={new Date(view.entry.ts).toISOString()} className="text-[10px] tabular-nums opacity-50">{entryTimeLabel(view.entry.ts)}</time>
            </div>
            {(view.actionHref ?? view.href) ? (
              <a href={view.actionHref ?? view.href} className="mt-1 block text-sm font-semibold tracking-tight underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink">{view.title}</a>
            ) : (
              <h3 className="mt-1 text-sm font-semibold tracking-tight">{view.title}</h3>
            )}
            {view.body ? <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 opacity-85">{view.body}</p> : null}
            {view.pinned.length ? (
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                {view.pinned.map((item) => (
                  <div key={item.label} className="min-w-0">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] opacity-45">{item.label}</dt>
                    <dd
                      className="mt-0.5 truncate font-mono text-xs font-medium"
                      title={item.full ?? undefined}
                    >
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {view.detail ? <p className="mt-2 text-xs leading-5 opacity-60">{view.detail}</p> : null}
            {view.href ? (
              <a
                href={view.href}
                className="mt-3 inline-flex min-h-10 items-center justify-center rounded-full border border-current/15 bg-current/10 px-3 text-xs font-semibold transition-[background-color,border-color] hover:bg-current/15 focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
              >
                {doorLabel(view.kind)}
              </a>
            ) : null}
          </div>
        </div>
      </article>
    </li>
  );
});

function LifecycleRun({ views, onReply }: { views: ChannelCardView[]; onReply?: (entry: ChannelEntry) => void }) {
  if (views.length === 1) return <ChannelTimelineRow view={views[0]!} onReply={onReply} />;
  const unit = views[0]!.pinned.find((item) => item.label === 'Unit')?.value ?? views[0]!.authorLabel;
  return (
    <li data-entry-id={views[0]!.id}>
      <details open className="group rounded-2xl border border-ink-border bg-panel">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-ink-text-body focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ember">
          <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden />
          <span className="truncate">{unit}</span>
          <span className="ml-auto text-[10px] font-medium uppercase tracking-[0.14em] text-ink-text-muted">{views.length} lifecycle updates</span>
        </summary>
        <ol className="space-y-3 border-t border-ink-border p-3">{views.map((view) => <ChannelTimelineRow key={view.id} view={view} onReply={onReply} />)}</ol>
      </details>
    </li>
  );
}

export function ChannelTimeline({ entries, loading, error, anchorEntryId, onReply }: { entries: ChannelEntry[]; loading: boolean; error: string; anchorEntryId?: string; onReply?: (entry: ChannelEntry) => void }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollStateRef = useRef<ChannelScrollState>(initialChannelScrollState());
  const [stableRows, setStableRows] = useState<ChannelCardView[]>([]);
  const views = useMemo(() => buildChannelThreadViews(entries), [entries]);
  const runs = useMemo(() => groupLifecycleRuns(stableRows), [stableRows]);

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
      {loading ? <LoadingTimeline /> : error ? <div className="m-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert"><AlertCircle className="h-4 w-4" aria-hidden /> {error}</div> : stableRows.length === 0 ? <EmptyTimeline /> : <ol className="mx-auto w-full max-w-4xl space-y-3 p-4 pb-10">{runs.map((run) => <LifecycleRun key={run[0]!.id} views={run} onReply={onReply} />)}</ol>}
    </div>
  );
}
