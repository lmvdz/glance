import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, CircleDot, FileText, Flame, GitMerge, Hash, Reply, Rocket, ShieldAlert } from 'lucide-react';
import type { ChannelEntry } from '../../lib/dto';
import { askedAgainLine, buildChannelThreadViews, doorLabel, groupLifecycleRuns, runSummary, type ChannelCardTone, type ChannelCardView } from '../../lib/channelTimeline';
import { foldVerdict } from '../../lib/roomState';
import { entryTimeLabel } from '../../lib/hub';
import { hubHref } from '../../lib/router';
import { channelScrollAfterRowsChange, channelScrollAfterUserScroll, initialChannelScrollState, type ChannelScrollState } from '../../lib/channelScroll';
import { GateVerdictCard } from './GateVerdictCard';
import { MentionedText } from '../chat/MentionOverlay';
import { attachmentIdFromPath, extractAttachedImagePaths, stripAttachedImageMarkers } from '../../lib/spawnProposal';

const MONO = "'JetBrains Mono',ui-monospace,monospace";

/** Tone as a 2px rule, not a filled panel — severity you can see without it shouting. */
const TONE_RULE: Record<ChannelCardTone, string> = {
  neutral: '#2A2A30',
  info: '#3E5C8A',
  warning: '#D9A03C',
  success: '#3E7D57',
  destructive: '#A6483C',
};

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
export const ChannelTimelineRow = memo(function ChannelTimelineRow({ view, onReply, replyingTo }: { view: ChannelCardView; onReply?: (entry: ChannelEntry) => void; replyingTo?: boolean }) {
  const user = view.entry.kind === 'user';
  const Icon = iconClass[view.kind];
  const attachmentIds = extractAttachedImagePaths(view.body)
    .map(attachmentIdFromPath)
    .filter((id): id is string => id !== undefined);
  const visibleBody = stripAttachedImageMarkers(view.body);
  if (view.kind === 'message') {
    // The reference has NO bubbles. A right-aligned rounded panel at 80% width wastes the measure and
    // makes a conversation read as a chat app rather than a room where work is discussed: avatar, then
    // name · role · time, then prose at 14px/1.55 against a 660px MEASURE — a reading width, not a
    // container. Human and agent messages share one shape, because the design treats them as the same
    // kind of thing.
    return (
      <li
        data-entry-id={view.id}
        className="group flex gap-3"
        // The message you are answering is marked where it actually is, not only quoted above the
        // input. A quote alone makes you trust that the app picked the right one; showing it in place
        // lets you see that it did. Deliberately faint — this is orientation, not an alarm.
        style={{ marginTop: 20, ...(replyingTo ? { background: '#141117', boxShadow: 'inset 2px 0 0 #F0A35A' } : {}) }}
      >
        <div
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[3px]"
          style={{ border: `1px solid ${user ? '#3A3A42' : '#2A3A4A'}`, fontFamily: MONO, fontSize: 11, color: user ? '#C9C9CF' : '#9EB4CC' }}
        >
          {(view.authorLabel || '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0" style={{ maxWidth: 660 }}>
          <div className="flex items-baseline gap-2">
            <div className="text-[13px] font-semibold" style={{ color: '#E8E8EA' }}>{view.authorLabel}</div>
            <time dateTime={new Date(view.entry.ts).toISOString()} style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
              {user ? 'you · ' : ''}{entryTimeLabel(view.entry.ts)}
            </time>
            {view.repliedBy ? <span style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{view.repliedBy} {view.repliedBy === 1 ? 'reply' : 'replies'}</span> : null}
          </div>
          {view.replyContext ? (
            <a href={hubHref(view.replyContext.channelId, view.replyContext.id)} className="mt-1.5 block py-0.5 pl-2" style={{ borderLeft: '2px solid #2A2A30' }}>
              <span className="block" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>replying to {view.replyContext.authorLabel}</span>
              <span className="line-clamp-2 block" style={{ fontSize: 12.5, color: '#7A7A82' }}>{view.replyContext.body}</span>
            </a>
          ) : null}
          {visibleBody ? (
            <p className="mt-[5px] whitespace-pre-wrap break-words" style={{ fontSize: 14, lineHeight: 1.7, color: '#DEDEE2', textWrap: 'pretty' }}><MentionedText text={visibleBody} /></p>
          ) : null}
          {attachmentIds.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2" aria-label={`${attachmentIds.length} attached image${attachmentIds.length === 1 ? '' : 's'}`}>
              {/* The transport path is `/api/chat-attachments/{id}` and nothing else. I hardcoded a
                  `/state/…png` URL while restyling this row, which would have 404'd every attachment
                  in the room — the styling changed, the plumbing was never mine to rewrite. */}
              {attachmentIds.map((id) => (
                <a
                  key={id}
                  href={`/api/chat-attachments/${id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-[3px]"
                  style={{ border: '1px solid #26262B' }}
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
          {onReply ? (
            <button type="button" onClick={() => onReply(view.entry)} className="mt-1.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>reply</button>
          ) : null}
        </div>
      </li>
    );
  }
  if (view.kind === 'gate-verdict') return <GateVerdictCard view={view} />;
  return (
    <li data-entry-id={view.id} className="group flex gap-3" style={{ marginTop: 20 }}>
      {/* A card is a thing the system says, and the design gives it the SAME shape as a person
          speaking: a mark, then a mono eyebrow, then prose on the reading measure. The rounded,
          shadowed, hover-lifting panel made every machine event heavier than a human sentence beside
          it, which is exactly backwards in a room whose whole point is that people matter more than
          telemetry. The tone now lives in a 2px left rule, not a filled box. */}
      <div
        className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[3px]"
        style={{ border: `1px solid ${TONE_RULE[view.tone]}44`, color: TONE_RULE[view.tone] }}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </div>
      <article className="min-w-0 flex-1" style={{ maxWidth: 660, borderLeft: `2px solid ${TONE_RULE[view.tone]}`, paddingLeft: 12 }}>
        <div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2" style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>
              {view.eyebrow ? <span style={{ letterSpacing: '.14em', textTransform: 'uppercase' }}>{view.eyebrow}</span> : null}
              <span>{view.authorLabel}</span>
              <time dateTime={new Date(view.entry.ts).toISOString()} className="tabular-nums">{entryTimeLabel(view.entry.ts)}</time>
            </div>
            {(view.actionHref ?? view.href) ? (
              <a href={view.actionHref ?? view.href} className="mt-1 block text-[13px] font-semibold underline-offset-4 hover:underline" style={{ color: '#E8E8EA' }}>{view.title}</a>
            ) : (
              <h3 className="mt-1 text-[13px] font-semibold" style={{ color: '#E8E8EA' }}>{view.title}</h3>
            )}
            {view.body ? <p className="mt-[5px] whitespace-pre-wrap break-words" style={{ fontSize: 14, lineHeight: 1.7, color: '#DEDEE2', textWrap: 'pretty' }}><MentionedText text={view.body} /></p> : null}
            {/* A question the fleet re-asked folds into the card already on screen and says so once.
                Three copies of one question makes the room look like it lost track of what it said. */}
            {askedAgainLine(view) ? (
              <p className="mt-2 text-[12px] leading-[1.5]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{askedAgainLine(view)}</p>
            ) : null}
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

function LifecycleRun({ views, onReply, replyingToId }: { views: ChannelCardView[]; onReply?: (entry: ChannelEntry) => void; replyingToId?: string }) {
  const [open, setOpen] = useState(false);
  if (views.length === 1) return <ChannelTimelineRow view={views[0]!} onReply={onReply} replyingTo={views[0]!.id === replyingToId} />;
  const summary = runSummary(views);
  const first = views[0]!.entry.ts;
  const last = views[views.length - 1]!.entry.ts;
  const span = entryTimeLabel(first) === entryTimeLabel(last) ? entryTimeLabel(first) : `${entryTimeLabel(first)}–${entryTimeLabel(last)}`;
  const alarming = Boolean(summary.unusual);

  // The reference's fold: one quiet line, not a panel. A bordered card around machine chatter gives it
  // the same visual weight as a person speaking, which is precisely backwards.
  return (
    <li data-entry-id={views[0]!.id} style={{ marginTop: 20 }}>
      <div
        className="flex cursor-pointer items-center gap-2.5 rounded-[3px] px-2.5 py-[7px]"
        style={{ border: `1px solid ${alarming ? '#3A2A18' : '#17171A'}`, background: '#0C0C0D' }}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setOpen((v) => !v); } }}
      >
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>{span}</div>
        <div className="h-[5px] w-[5px] flex-none rounded-full" style={{ background: alarming ? '#D9A03C' : '#3E5C8A' }} />
        <div className="min-w-0 flex-1 truncate" style={{ fontFamily: MONO, fontSize: 10.5, color: alarming ? '#C9A27A' : '#6A6A72' }}>
          {foldVerdict(summary)}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: '#4A4A52' }}>{open ? 'close' : 'open'}</div>
      </div>
      {open ? <ol className="mt-1 pl-[38px]">{views.map((view) => <ChannelTimelineRow key={view.id} view={view} onReply={onReply} replyingTo={view.id === replyingToId} />)}</ol> : null}
    </li>
  );
}

export function ChannelTimeline({ entries, loading, error, anchorEntryId, onReply, emptyState, replyingToId }: { entries: ChannelEntry[]; loading: boolean; error: string; anchorEntryId?: string; onReply?: (entry: ChannelEntry) => void; emptyState?: React.ReactNode; replyingToId?: string }) {
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
      {loading ? <LoadingTimeline /> : error ? <div className="m-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert"><AlertCircle className="h-4 w-4" aria-hidden /> {error}</div> : stableRows.length === 0 ? (emptyState ?? <EmptyTimeline />) : <ol className="mx-auto w-full max-w-4xl space-y-3 p-4 pb-10">{runs.map((run) => <LifecycleRun key={run[0]!.id} views={run} onReply={onReply} replyingToId={replyingToId} />)}</ol>}
    </div>
  );
}
