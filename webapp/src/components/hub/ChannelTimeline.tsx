import React from 'react';
import { AlertCircle, Hash } from 'lucide-react';
import type { ChannelEntry } from '../../lib/dto';
import { entryAuthorLabel, reduceChannelEntries } from '../../lib/hub';
import { TranscriptEntryView } from '../chat/TranscriptTimeline';

interface ChannelTimelineProps {
  channelId: string;
  entries: ChannelEntry[];
  loading?: boolean;
  error?: string;
}

type ProofCardFace = {
  title?: unknown;
  status?: unknown;
  summary?: unknown;
};




function ProofCard({ entry }: { entry: ChannelEntry }) {
  const rawFace = (entry.event?.payload as { face?: unknown } | null | undefined)?.face;
  const face = rawFace && typeof rawFace === 'object' ? (rawFace as ProofCardFace) : undefined;
  const title = typeof face?.title === 'string' && face.title.trim() ? face.title : entry.text || 'Proof card';
  const status = typeof face?.status === 'string' && face.status.trim() ? face.status : 'proof';
  const summary = typeof face?.summary === 'string' && face.summary.trim() ? face.summary : entry.text || 'Manager-authored proof event.';
  return (
    <article
      className="max-w-2xl rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-zinc-100"
      data-channel-card="proof-card"
      data-event-kind={entry.event?.kind}
      aria-label={`Proof card: ${title}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-200">
        <span>{entryAuthorLabel(entry)}</span>
        <span className="tabular-nums">#{entry.seq}</span>
        <span className="rounded-full border border-amber-200/30 px-1.5 py-0.5">{status}</span>
      </div>
      <h2 className="text-sm font-semibold tracking-tight text-zinc-50">{title}</h2>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-zinc-300">{summary}</p>
    </article>
  );
}

function EventFallbackCard({ entry }: { entry: ChannelEntry }) {
  return (
    <article
      className="max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-200"
      data-channel-card="event-fallback"
      data-event-kind={entry.event?.kind}
      aria-label={`Channel event: ${entry.event?.kind ?? 'unknown'}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        <span>{entryAuthorLabel(entry)}</span>
        <span className="tabular-nums">#{entry.seq}</span>
        <span className="rounded-full border border-zinc-700 px-1.5 py-0.5 text-zinc-400">{entry.event?.kind ?? 'event'}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{entry.text || 'Unsupported channel event.'}</p>
    </article>
  );
}

const TranscriptCard = React.memo(({ entry }: { entry: ChannelEntry }) => {
  const user = entry.kind === 'user';
  return (
    <article
      className={`max-w-2xl rounded-2xl border px-3 py-2 ${user ? 'border-zinc-700 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-[#0c0c0e] text-zinc-200'}`}
      data-channel-card={user ? 'human-message' : 'agent-reply'}
      aria-label={`Channel message from ${entryAuthorLabel(entry)}`}
    >
      <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        <span>{entryAuthorLabel(entry)}</span>
        <span className="tabular-nums">#{entry.seq}</span>
      </div>
      <TranscriptEntryView entry={entry} />
    </article>
  );
});

function ChannelEntryCard({ entry }: { entry: ChannelEntry }) {
  if (entry.event?.kind === 'proof-card') return <ProofCard entry={entry} />;
  if (entry.event?.kind) return <EventFallbackCard entry={entry} />;
  return <TranscriptCard entry={entry} />;
}

export function ChannelTimeline({ channelId, entries, loading = false, error = '' }: ChannelTimelineProps) {
  const ordered = React.useMemo(() => reduceChannelEntries([], entries, channelId), [entries, channelId]);

  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-label="Loading channel" data-channel-timeline={channelId} aria-busy="true">
        {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-14 rounded-xl border border-zinc-800 bg-zinc-900/60" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="m-4 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert" data-channel-timeline={channelId}>
        <AlertCircle className="h-4 w-4" aria-hidden /> {error}
      </div>
    );
  }
  if (ordered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center" data-channel-timeline={channelId}>
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
  return (
    <ol className="space-y-3 p-4" data-channel-timeline={channelId} aria-label={`Channel timeline ${channelId}`}>
      {ordered.map((entry) => (
        <li key={entry.id} className={`flex ${entry.kind === 'user' && !entry.event ? 'justify-end' : 'justify-start'}`}>
          <ChannelEntryCard entry={entry} />
        </li>
      ))}
    </ol>
  );
}
