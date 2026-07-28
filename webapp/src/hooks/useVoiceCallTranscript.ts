import { useEffect, useRef, useState } from 'react';
import { fetchVoiceCallTranscript, type VoiceCallTranscriptEntryDTO } from '../lib/api';
import { mergeLiveTurn, sortTranscriptTurns } from '../lib/voice/transcript';
import type { VoiceCallTranscriptTurnEvent } from './useSquad';

/**
 * useVoiceCallTranscript — the call's conversation pane's own transport wrapper, matching
 * `useRoomCall`'s split: this hook is a thin imperative shell; every judgement (merge-in-place,
 * register, empty-state copy) lives in `lib/voice/transcript.ts`, testable without React.
 *
 * Two sources, reconciled, neither trusted alone:
 *  - A REST poll of the FULL retained transcript (`fetchVoiceCallTranscript`) — the record. Refresh
 *    rehydrates from this alone; it needs no live push to work at all.
 *  - Live `voice-call-transcript-turn` SquadEvents (concern 11) — a low-latency nudge so a turn can
 *    appear the moment it lands rather than waiting out the poll interval. Merged in place by
 *    `(role, turn)`, per `mergeLiveTurn`'s doc — never a second copy of the same turn.
 * Each live event is merged AT MOST ONCE (a `WeakSet` of already-processed event objects, robust to
 * `useSquad`'s own ring-buffer trimming old entries out from under an index-based cursor).
 */

const POLL_MS = 3_000;

export interface VoiceCallTranscriptState {
  turns: VoiceCallTranscriptEntryDTO[];
  loading: boolean;
  error: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useVoiceCallTranscript(channelId: string, callId: string | undefined, liveEvents: readonly VoiceCallTranscriptTurnEvent[]): VoiceCallTranscriptState {
  const [turns, setTurns] = useState<VoiceCallTranscriptEntryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const processedRef = useRef(new WeakSet<VoiceCallTranscriptTurnEvent>());

  // A different call (or leaving the channel entirely) starts from nothing — a decision from a
  // different call's conversation must never linger in this one's pane.
  useEffect(() => {
    setTurns([]);
    setLoading(true);
    setError('');
    processedRef.current = new WeakSet();
  }, [channelId, callId]);

  useEffect(() => {
    if (!callId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchVoiceCallTranscript(channelId);
        if (cancelled) return;
        setTurns(sortTranscriptTurns(next));
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
      clearInterval(timer);
    };
  }, [channelId, callId]);

  useEffect(() => {
    if (!callId) return;
    const fresh = liveEvents.filter((event) => !processedRef.current.has(event) && event.channelId === channelId && event.callId === callId);
    if (!fresh.length) return;
    for (const event of fresh) processedRef.current.add(event);
    setTurns((current) => fresh.reduce((acc, event) => mergeLiveTurn(acc, event.entry), current));
  }, [liveEvents, channelId, callId]);

  return { turns, loading, error };
}
