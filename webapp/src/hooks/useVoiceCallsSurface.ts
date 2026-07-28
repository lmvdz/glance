import { useCallback, useEffect, useRef, useState } from 'react';
import { endOrphanVoiceCall, endVoiceCall, fetchVoiceCallsSurface, reattachVoiceCall, type VoiceCallBindingDTO, type VoiceCallOrphanDTO } from '../lib/api';

/**
 * useVoiceCallsSurface — the calls-management panel's own transport wrapper (concern 10:
 * call-management-ui), matching `useRoomCall`'s split: thin imperative shell, no judgement — the
 * row-building/urgency/action-availability logic lives in `lib/voice/roomCall.ts`
 * (`callSurfaceRows`/`callSurfaceBindingRow`/`callSurfaceOrphanRow`), testable without React.
 *
 * Polls the SAME 3s cadence `useRoomCall` already established for this feature area (see that
 * hook's own doc for why this codebase treats a short poll as "live" here rather than reaching for
 * a new WS event type) — this surface is explicitly cross-room, so there is no single channel's
 * `voice-call` card to react to anyway.
 */

const POLL_MS = 3_000;

export interface VoiceCallsSurfaceState {
  bindings: VoiceCallBindingDTO[];
  orphans: VoiceCallOrphanDTO[];
  loading: boolean;
  error: string;
  /** Per-callId busy flag — End is single-flight PER ROW, not global, so ending one orphan never
   *  disables the End button on every other row while it's in flight. */
  endingCallIds: ReadonlySet<string>;
  /** Per-channelId busy flags — End and Reattach act on a DIFFERENT room's binding than whichever
   *  one (if any) is currently open in this browser tab, so this hook owns its own single-flight
   *  state rather than depending on that room's own `useRoomCall` instance existing at all. */
  endingChannelIds: ReadonlySet<string>;
  reattachingChannelIds: ReadonlySet<string>;
  endOrphan: (callId: string) => void;
  endBinding: (channelId: string) => void;
  reattachBinding: (channelId: string) => void;
  refresh: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useVoiceCallsSurface(active: boolean): VoiceCallsSurfaceState {
  const [bindings, setBindings] = useState<VoiceCallBindingDTO[]>([]);
  const [orphans, setOrphans] = useState<VoiceCallOrphanDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pollTick, setPollTick] = useState(0);
  const [endingCallIds, setEndingCallIds] = useState<ReadonlySet<string>>(new Set());
  const [endingChannelIds, setEndingChannelIds] = useState<ReadonlySet<string>>(new Set());
  const [reattachingChannelIds, setReattachingChannelIds] = useState<ReadonlySet<string>>(new Set());
  const aliveRef = useRef(true);

  const refresh = useCallback(() => setPollTick((tick) => tick + 1), []);

  useEffect(() => {
    // Only polls while the panel is actually open — this surface is cross-room and has no natural
    // "channel changed" boundary to reset on, so `active` (the pane being on screen) is the gate.
    if (!active) return;
    aliveRef.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        const surface = await fetchVoiceCallsSurface();
        if (cancelled) return;
        setBindings(surface.bindings);
        setOrphans(surface.orphans);
        setError('');
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [active, pollTick]);

  const endOrphan = useCallback(
    (callId: string) => {
      setEndingCallIds((current) => new Set(current).add(callId));
      void endOrphanVoiceCall(callId)
        .catch((err) => {
          if (aliveRef.current) setError(`Could not end call ${callId}: ${errorText(err)}`);
        })
        .finally(() => {
          setEndingCallIds((current) => {
            const next = new Set(current);
            next.delete(callId);
            return next;
          });
          refresh();
        });
    },
    [refresh],
  );

  const endBinding = useCallback(
    (channelId: string) => {
      setEndingChannelIds((current) => new Set(current).add(channelId));
      void endVoiceCall(channelId)
        .catch((err) => {
          if (aliveRef.current) setError(`Could not end the call in ${channelId}: ${errorText(err)}`);
        })
        .finally(() => {
          setEndingChannelIds((current) => {
            const next = new Set(current);
            next.delete(channelId);
            return next;
          });
          refresh();
        });
    },
    [refresh],
  );

  const reattachBinding = useCallback(
    (channelId: string) => {
      setReattachingChannelIds((current) => new Set(current).add(channelId));
      void reattachVoiceCall(channelId)
        .catch((err) => {
          if (aliveRef.current) setError(`Reattach failed for ${channelId}: ${errorText(err)}`);
        })
        .finally(() => {
          setReattachingChannelIds((current) => {
            const next = new Set(current);
            next.delete(channelId);
            return next;
          });
          refresh();
        });
    },
    [refresh],
  );

  return { bindings, orphans, loading, error, endingCallIds, endingChannelIds, reattachingChannelIds, endOrphan, endBinding, reattachBinding, refresh };
}
