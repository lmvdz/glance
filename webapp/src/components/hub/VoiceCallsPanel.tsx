import React from 'react';
import { AlertCircle, Loader2, PhoneOff, RefreshCw } from 'lucide-react';
import { PHASE_LABEL, callSurfaceRowDetail, callSurfaceRows, type CallSurfaceRow } from '../../lib/voice/roomCall';
import type { VoiceCallBindingDTO, VoiceCallOrphanDTO } from '../../lib/api';

/**
 * VoiceCallsPanel — the calls-management surface (concern 10, plans/voice-orchestrated-room-
 * integration/10-call-management-ui.md).
 *
 * Answers the Goal directly: a user must always be able to SEE that a call/session exists, END it,
 * and REATTACH to it — from the UI, without curl. Every row here is one call this actor can act on
 * (a binding in some room, or a broker ORPHAN with no room at all — see `callSurfaceRows`'s doc),
 * with an honest mic-capture badge (checked/unverified) and only the actions that actually apply.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

const MIC_BADGE: Record<CallSurfaceRow['micState'], { label: string; color: string }> = {
  checked: { label: 'checked', color: '#7FB093' },
  unverified: { label: 'unverified', color: '#D9A03C' },
  none: { label: 'none', color: '#5A5A61' },
};

export interface VoiceCallsPanelProps {
  bindings: VoiceCallBindingDTO[];
  orphans: VoiceCallOrphanDTO[];
  loading: boolean;
  error: string;
  endingCallIds: ReadonlySet<string>;
  endingChannelIds: ReadonlySet<string>;
  reattachingChannelIds: ReadonlySet<string>;
  onEndOrphan: (callId: string) => void;
  onEndBinding: (channelId: string) => void;
  onReattachBinding: (channelId: string) => void;
  onClose: () => void;
}

export function VoiceCallsPanel({
  bindings,
  orphans,
  loading,
  error,
  endingCallIds,
  endingChannelIds,
  reattachingChannelIds,
  onEndOrphan,
  onEndBinding,
  onReattachBinding,
  onClose,
}: VoiceCallsPanelProps) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = callSurfaceRows(bindings, orphans);
  const empty = !loading && !error && rows.length === 0;

  return (
    <aside
      className="flex w-full flex-none flex-col overflow-hidden md:w-[560px]"
      data-room-workspace=""
      style={{ background: '#0C0C0D', borderLeft: '1px solid #1F1F22' }}
      aria-label="Calls across every room"
    >
      <div className="flex-none px-4 pb-2.5 pt-3.5" style={{ borderBottom: '1px solid #1F1F22' }}>
        <div className="flex items-baseline gap-2.5">
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>CALLS</div>
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="space-y-2" aria-label="Loading calls">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-14 rounded-[3px] skeleton" style={{ border: '1px solid #1C1C20', background: '#101012' }} />
            ))}
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 px-3 py-2.5 text-[12.5px]" style={{ border: '1px solid #241A17', borderLeft: '2px solid #B4553A', background: '#100D0C', color: '#DEDEE2' }} role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" style={{ color: '#C2704A' }} aria-hidden />
            <span style={{ textWrap: 'pretty' }}>{error}</span>
          </div>
        ) : empty ? (
          <p className="text-[12.5px] leading-[1.5]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>
            No calls anywhere this account can see, and no orphaned broker process either.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => {
              const key = row.kind === 'binding' ? `binding:${row.channelId}` : `orphan:${row.callId}`;
              const badge = MIC_BADGE[row.micState];
              const busyEnd = row.kind === 'binding' ? endingChannelIds.has(row.channelId) : endingCallIds.has(row.callId);
              const busyReattach = row.kind === 'binding' && reattachingChannelIds.has(row.channelId);
              return (
                <li
                  key={key}
                  className="flex items-start gap-3 rounded-[3px] px-3 py-2.5"
                  style={{ border: '1px solid #1C1C20', borderLeft: `2px solid ${row.urgent ? '#D9A03C' : '#26262B'}`, background: '#101012' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="truncate text-[12.5px] font-semibold" style={{ color: '#DEDEE2' }}>
                        {row.kind === 'binding' ? `#${row.channelId}` : 'orphan (no room)'}
                      </span>
                      {row.kind === 'binding' ? (
                        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#8A8A91' }}>{PHASE_LABEL[row.state]}</span>
                      ) : null}
                      <span aria-label={`Mic state: ${badge.label}`} title="Whether a live socket confirms this call is actually attached" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: badge.color }}>
                        mic {badge.label}
                      </span>
                      {row.urgent ? (
                        <span role="alert" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: '#D9A03C' }}>
                          urgent
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#7A7A82', textWrap: 'pretty' }}>
                      {callSurfaceRowDetail(row)}
                    </p>
                    {row.callId ? (
                      <p className="mt-0.5 truncate" style={{ fontFamily: MONO, fontSize: 10, color: '#4A4A52' }} title={row.callId}>
                        call {row.callId.slice(0, 12)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    {row.kind === 'binding' && row.canReattach ? (
                      <button
                        type="button"
                        onClick={() => onReattachBinding(row.channelId)}
                        disabled={busyReattach}
                        aria-label={`Reattach to the call in ${row.channelId}`}
                        className="flex h-9 min-w-9 items-center justify-center gap-1 rounded-[3px] px-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ border: '1px solid #4A3319', color: '#D9A03C' }}
                      >
                        {busyReattach ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                        <span>Reattach</span>
                      </button>
                    ) : null}
                    {(row.kind === 'binding' && row.canEnd) || row.kind === 'orphan' ? (
                      <button
                        type="button"
                        onClick={() => (row.kind === 'binding' ? onEndBinding(row.channelId) : onEndOrphan(row.callId))}
                        disabled={busyEnd}
                        aria-label={row.kind === 'binding' ? `End the call in ${row.channelId}` : `End orphan call ${row.callId}`}
                        className="flex h-9 min-w-9 items-center justify-center gap-1 rounded-[3px] px-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ border: '1px solid #3A2320', color: '#C58A7E' }}
                      >
                        {busyEnd ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <PhoneOff className="h-3.5 w-3.5" aria-hidden />}
                        <span>End</span>
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
