import { useEffect, useState } from 'react';
import {
  connectVoiceCallAudio,
  DEFAULT_OUTPUT_SAMPLE_RATE_HZ,
  micPermissionErrorMessage,
  startAudioPlayback,
  startMicCapture,
  type VoiceAudioStatus,
} from '../lib/voice/audioRelay';

/**
 * useRoomCallAudio — concern 09 (browser-audio-transport): opens the browser's mic/speaker relay
 * for a room call running `omp live --no-local-audio`, and tears it down the moment it stops
 * applying. Thin transport wrapper, matching `useRoomCall`'s own split (judgement lives in
 * `lib/voice/audioRelay.ts`, this hook is the imperative shell React needs around it).
 *
 * `audioAvailable` — read from `useRoomCall`'s own `binding?.audioAvailable` — is the ONE input
 * that starts/stops everything here: it is already `noLocalAudio && controlsAvailable` (both
 * daemon-checked), so this hook never has to re-derive "should the mic even be requested" itself.
 */

export type RoomCallMicStatus = 'idle' | 'requesting' | 'active' | 'denied';

export interface RoomCallAudioState {
  /** Mirrors the `audioAvailable` input — convenience for a caller that destructures this alone. */
  available: boolean;
  micStatus: RoomCallMicStatus;
  /** `'idle'` before/after the relay is even open — distinct from `VoiceAudioStatus`'s own values,
   *  none of which mean "not applicable to this call". */
  relayStatus: VoiceAudioStatus | 'idle';
  /** The most recent relay/mic failure, kept in place (never a toast that vanishes) — same
   *  discipline `useRoomCall`'s own `error` field already uses for start/end failures. */
  error?: string;
  /** Re-requests mic permission (and, if the relay itself dropped, reopens it) without the caller
   *  having to leave and re-enter the call — a denied `getUserMedia` prompt is exactly the kind of
   *  "the operator changed their mind in the browser's own permission UI" case worth an explicit
   *  retry, per `voiceSession.ts`'s own "no re-prompt loop, but the caller may offer one" doctrine. */
  retry: () => void;
}

export function useRoomCallAudio(channelId: string, audioAvailable: boolean): RoomCallAudioState {
  const [micStatus, setMicStatus] = useState<RoomCallMicStatus>('idle');
  const [relayStatus, setRelayStatus] = useState<VoiceAudioStatus | 'idle'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!audioAvailable) {
      setMicStatus('idle');
      setRelayStatus('idle');
      setError(undefined);
      return;
    }
    let cancelled = false;
    let micHandle: { stop: () => void } | undefined;
    let playback: ReturnType<typeof startAudioPlayback> | undefined;
    setError(undefined);

    const relay = connectVoiceCallAudio(channelId, {
      onStatus: (status, reason) => {
        if (cancelled) return;
        setRelayStatus(status);
        if (status === 'refused') {
          setError(`The browser audio relay was refused: ${reason ?? 'unknown reason'}`);
          return;
        }
        if (status === 'closed') {
          setError((current) => current ?? 'The browser audio relay connection was lost.');
          return;
        }
        if (status !== 'ready') return;
        playback = startAudioPlayback(DEFAULT_OUTPUT_SAMPLE_RATE_HZ);
        setMicStatus('requesting');
        void startMicCapture((samples) => relay.sendMic(samples))
          .then((handle) => {
            if (cancelled) {
              handle.stop();
              return;
            }
            micHandle = handle;
            setMicStatus('active');
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            setMicStatus('denied');
            setError(micPermissionErrorMessage(err));
          });
      },
      onOutputAudio: (bytes) => playback?.push(bytes),
    });

    return () => {
      cancelled = true;
      micHandle?.stop();
      playback?.stop();
      relay.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retryTick exists only to re-run this effect on demand
  }, [channelId, audioAvailable, retryTick]);

  return {
    available: audioAvailable,
    micStatus,
    relayStatus,
    error,
    retry: () => {
      setError(undefined);
      setRetryTick((tick) => tick + 1);
    },
  };
}
