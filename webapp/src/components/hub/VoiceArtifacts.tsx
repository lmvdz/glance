import React from 'react';
import { AlertCircle, ChevronLeft, FileText, Loader2 } from 'lucide-react';
import { SettledMarkdown } from '../chat/SettledMarkdown';
import { ALL_AGENTS, artifactEmptyCopy, artifactStateCopy, type ArtifactGroup, type ArtifactRow } from '../../lib/voice/roomCall';
import type { VoiceCallArtifactReadFailure, VoiceCallBindingDTO } from '../../lib/api';

/**
 * VoiceArtifacts — the per-thread index of what a run produced, and the reader for one file.
 *
 * "A timeline card is an event; the index answers what the run produced." The timeline already
 * shows that a file appeared; this answers the different question of what exists now, grouped by
 * run with the current one first, filterable by agent, in a stable order that survives a poll.
 *
 * The viewer renders the IMMUTABLE SNAPSHOT the daemon copied, through the room's existing Markdown
 * stack (`SettledMarkdown` → the trusted block registry → the same sanitizer every other lane
 * uses). Markdown here is a host document viewer and nothing more: no bespoke renderer, no new
 * sanitization path, no visualizer feature. `status="ok"` because a snapshot is by definition
 * complete — there is no streaming tail to guard.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

const STATE_INK: Record<ArtifactRow['state'], string> = {
  ready: '#C9C9CF',
  writing: '#9AB0C6',
  missing: '#C2704A',
  failed: '#C2704A',
};

function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export interface VoiceArtifactsListProps {
  groups: ArtifactGroup[];
  agentOptions: string[];
  agentFilter: string;
  onFilterChange: (value: string) => void;
  onOpen: (row: ArtifactRow) => void;
  onClose: () => void;
  loading: boolean;
  error?: string;
  binding: VoiceCallBindingDTO | null;
  now: number;
  /** Restored on the way back from a drill-in, and reported on the way out. */
  scrollTop: number;
  onScroll: (scrollTop: number) => void;
}

export function VoiceArtifactsList({
  groups,
  agentOptions,
  agentFilter,
  onFilterChange,
  onOpen,
  onClose,
  loading,
  error,
  binding,
  now,
  scrollTop,
  onScroll,
}: VoiceArtifactsListProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    // Restore where the reader was. Set imperatively rather than through a style so it survives the
    // list re-rendering underneath it, and only once per mount — a poll must not yank the view back.
    const scroller = scrollerRef.current;
    if (scroller && scrollTop > 0) scroller.scrollTop = scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore on mount only; later polls must not re-scroll
  }, []);

  React.useEffect(() => {
    // Escape pops this pane, the same promise the header makes — but never out of a field, where
    // Escape means "abandon what I am writing" (the agent filter is a `select`, and Escape inside
    // an open one belongs to the select).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const empty = groups.every((group) => group.rows.length === 0);

  return (
    <aside
      className="flex w-full flex-none flex-col overflow-hidden md:w-[520px]"
      data-room-workspace=""
      style={{ background: '#0C0C0D', borderLeft: '1px solid #1F1F22' }}
      aria-label="Artifacts this run produced"
    >
      <div className="flex-none px-4 pb-2.5 pt-3.5" style={{ borderBottom: '1px solid #1F1F22' }}>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>WHAT THIS RUN PRODUCED</div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-[3px] px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}
          >
            esc closes
          </button>
        </div>

        <div className="mt-2.5 flex items-center gap-2">
          <label htmlFor="voice-artifact-agent" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: '#5A5A61' }}>
            AGENT
          </label>
          <select
            id="voice-artifact-agent"
            value={agentFilter}
            onChange={(event) => onFilterChange(event.target.value)}
            className="min-h-9 rounded-[3px] px-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            style={{ border: '1px solid #26262B', background: '#0A0A0B', color: '#C9C9CF' }}
          >
            {agentOptions.map((option) => (
              <option key={option} value={option}>
                {option === ALL_AGENTS ? 'All agents' : option}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        ref={scrollerRef}
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {loading ? (
          <div className="space-y-2" aria-label="Loading artifacts">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-12 rounded-[3px] skeleton" style={{ border: '1px solid #1C1C20', background: '#101012' }} />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-3 py-2.5 text-[12.5px]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2' }} role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" style={{ color: '#C2704A' }} aria-hidden />
            <span style={{ textWrap: 'pretty' }}>{error}</span>
          </div>
        ) : empty ? (
          <p className="text-[12.5px] leading-[1.5]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>
            {artifactEmptyCopy(binding, agentFilter !== ALL_AGENTS)}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.callId} className="mb-4 last:mb-0">
              <div className="mb-1.5 flex items-baseline gap-2" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.12em', color: group.current ? '#F0A35A' : '#4A4A52' }}>
                <span>{group.current ? 'THIS RUN' : 'EARLIER RUN'}</span>
                <span style={{ color: '#4A4A52' }} title={`Call ${group.callId}`}>{group.callId.slice(0, 8)}</span>
              </div>
              <ul className="flex flex-col gap-1">
                {group.rows.map((row) => {
                  const stateCopy = artifactStateCopy(row);
                  const openable = row.state === 'ready';
                  const body = (
                    <>
                      <FileText className="mt-0.5 h-3.5 w-3.5 flex-none" style={{ color: STATE_INK[row.state] }} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="truncate text-[12.5px] font-medium" style={{ color: STATE_INK[row.state] }} title={row.path}>{row.name}</span>
                          <span style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{row.agent}</span>
                          {row.revision && row.revision > 1 ? <span style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>rev {row.revision}</span> : null}
                          {row.superseded ? <span style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>superseded</span> : null}
                          <span style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }}>{relativeTime(row.copiedAt, now)}</span>
                        </span>
                        {stateCopy ? (
                          <span className="mt-0.5 block text-[11.5px] leading-[1.45]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>{stateCopy}</span>
                        ) : null}
                      </span>
                    </>
                  );
                  return (
                    <li key={row.id}>
                      {openable ? (
                        <button
                          type="button"
                          onClick={() => onOpen(row)}
                          className="flex w-full items-start gap-2 rounded-[3px] px-2 py-2 text-left transition-colors hover:bg-[#121214] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2"
                          style={{ minHeight: 40 }}
                        >
                          {body}
                        </button>
                      ) : (
                        // Not a button: there is nothing behind it to open, and a control that does
                        // nothing when pressed teaches a reader to distrust the ones that work.
                        <div className="flex items-start gap-2 rounded-[3px] px-2 py-2" style={{ minHeight: 40 }}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

export interface VoiceArtifactViewerProps {
  row: ArtifactRow;
  content?: string;
  loading: boolean;
  /** A NAMED read failure, so each one reads differently — see `VoiceCallArtifactReadError`. */
  failure?: { reason: VoiceCallArtifactReadFailure; detail?: string };
  onBack: () => void;
}

const FAILURE_COPY: Record<VoiceCallArtifactReadFailure, string> = {
  'not-ready': 'There is no snapshot of this one. The row above says why it never got copied.',
  missing: 'The room recorded this snapshot and the file is no longer where it was written. That is a fault worth reporting — it is not an empty document.',
  'too-large': 'This file is too large to read in the room. It is snapshotted and intact; it just is not a thing to scroll through here.',
  'read-error': 'The snapshot could not be read.',
};

export function VoiceArtifactViewer({ row, content, loading, failure, onBack }: VoiceArtifactViewerProps) {
  const backRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    // Opening a document is a deliberate act, so focus follows it — onto Back, which is both the
    // way out and a harmless place for a stray Enter to land.
    backRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <aside
      className="flex w-full flex-none flex-col overflow-hidden md:w-[520px]"
      data-room-workspace=""
      style={{ background: '#0C0C0D', borderLeft: '1px solid #1F1F22' }}
      aria-label={`Reading ${row.name}`}
    >
      <div className="flex flex-none items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid #1F1F22' }}>
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          className="inline-flex min-h-9 items-center gap-1 rounded-[3px] px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2"
          style={{ border: '1px solid #26262B', color: '#C9C9CF', fontFamily: MONO }}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          back
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold" style={{ color: '#E8E8EA' }} title={row.path}>{row.name}</div>
          <div className="truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }} title={row.contentHash}>
            {row.agent}
            {row.revision ? ` · rev ${row.revision}` : ''}
            {row.contentHash ? ` · ${row.contentHash.slice(0, 12)}` : ''}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center gap-2 text-[12px]" style={{ color: '#6A6A72' }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> reading the snapshot…
          </div>
        ) : failure ? (
          <div className="px-3.5 py-2.5" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C' }} role="alert">
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#C2704A' }}>THIS CANNOT BE SHOWN</div>
            <p className="mt-1.5 text-[12.5px] leading-[1.5]" style={{ color: '#DEDEE2', textWrap: 'pretty' }}>{FAILURE_COPY[failure.reason]}</p>
            {failure.detail ? <p className="mt-1.5" style={{ fontFamily: MONO, fontSize: 10.5, color: '#7A7A82' }}>{failure.detail}</p> : null}
          </div>
        ) : content !== undefined && content.trim() === '' ? (
          <p className="text-[12.5px]" style={{ color: '#7A7A82' }}>This snapshot is empty. The file the run produced had nothing in it.</p>
        ) : (
          // The room's existing renderer, on an immutable snapshot. `status="ok"`: a snapshot is
          // complete by construction, so the streaming-tail machinery has nothing to do here.
          <div className="prose-room text-[13.5px] leading-[1.65]" style={{ color: '#DEDEE2' }}>
            <SettledMarkdown text={content ?? ''} status="ok" />
          </div>
        )}
      </div>
    </aside>
  );
}
