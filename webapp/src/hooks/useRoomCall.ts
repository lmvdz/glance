import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  endVoiceCall,
  fetchVoiceCallArtifacts,
  fetchVoiceCallDecisions,
  fetchVoiceCallGaps,
  fetchVoiceCallState,
  resolveVoiceCallDecision,
  setVoiceCallMuted,
  startVoiceCall,
  steerVoiceCall,
  type VoiceCallArtifactDTO,
  type VoiceCallBindingDTO,
  type VoiceCallDecisionDTO,
  type VoiceCallJournalGapDTO,
} from '../lib/api';
import { readResolveAck, steerRefusalCopy, type ResolveOutcome, type SteerState } from '../lib/voice/roomCall';

/**
 * useRoomCall — the thread's live call, as one piece of state the room can render.
 *
 * Everything here is a THIN transport wrapper plus the bookkeeping a poll loop needs; every
 * judgement (status precedence, register, artifact grouping, refusal copy) lives in
 * `lib/voice/roomCall.ts` where it can be tested without a browser.
 *
 * Two disciplines worth naming:
 *
 * - **Single-flight, everywhere.** Start, end, mute and resolve each guard against a second
 *   in-flight request. Two `POST /voice-call`s race a 409 into the UI; two resolves race the
 *   arbiter. The guard is a ref, not state, so it takes effect on the same tick as the click.
 * - **Nothing is claimed before it is acknowledged.** `steer` reports `sending` and only becomes
 *   `delivered` on the daemon's ok. A refusal keeps its real reason. There is no optimistic path.
 */

const POLL_MS = 3_000;

export interface RoomCallState {
  binding: VoiceCallBindingDTO | null;
  decisions: VoiceCallDecisionDTO[];
  artifacts: VoiceCallArtifactDTO[];
  gaps: VoiceCallJournalGapDTO[];
  loading: boolean;
  /** A start/end failure, kept in place rather than flashed as a toast. */
  error: string;
  starting: boolean;
  ending: boolean;
  muteBusy: boolean;
  /** What the daemon has last been asked for; `false` when there is no live call. */
  muted: boolean;
  controlsAvailable: boolean;
  steer: SteerState | undefined;
  /** The last decision-resolution refusal, per decision id. */
  refusals: Record<string, string>;
  /** Set while one option is in flight, so exactly one control shows the pending state. */
  pendingOption: { decisionId: string; optionIndex: number } | undefined;
  /** Held between the first answer and its confirming second act. */
  confirmPending: { decisionId: string; optionIndex: number; label: string; confirmToken?: string } | undefined;
  start: () => void;
  end: () => void;
  toggleMute: () => void;
  chooseOption: (decisionId: string, optionIndex: number, label: string) => Promise<ResolveOutcome | undefined>;
  confirm: () => Promise<ResolveOutcome | undefined>;
  cancelConfirm: () => void;
  sendSteer: (text: string) => Promise<boolean>;
  clearSteer: () => void;
  refresh: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useRoomCall(channelId: string): RoomCallState {
  const [binding, setBinding] = useState<VoiceCallBindingDTO | null>(null);
  const [decisions, setDecisions] = useState<VoiceCallDecisionDTO[]>([]);
  const [artifacts, setArtifacts] = useState<VoiceCallArtifactDTO[]>([]);
  const [gaps, setGaps] = useState<VoiceCallJournalGapDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [steer, setSteer] = useState<SteerState | undefined>(undefined);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [pendingOption, setPendingOption] = useState<RoomCallState['pendingOption']>(undefined);
  const [confirmPending, setConfirmPending] = useState<RoomCallState['confirmPending']>(undefined);
  const [pollTick, setPollTick] = useState(0);

  const inFlight = useRef({ start: false, end: false, mute: false, resolve: false });
  const aliveRef = useRef(true);

  // Every piece of per-channel state resets on a channel change — a decision from the room you just
  // left must never be answerable from the room you just entered.
  useEffect(() => {
    setBinding(null);
    setDecisions([]);
    setArtifacts([]);
    setGaps([]);
    setLoading(true);
    setError('');
    setSteer(undefined);
    setRefusals({});
    setPendingOption(undefined);
    setConfirmPending(undefined);
  }, [channelId]);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        const state = await fetchVoiceCallState(channelId);
        if (cancelled) return;
        setBinding(state);
        if (!state) {
          setDecisions([]);
          setArtifacts([]);
          setGaps([]);
          return;
        }
        const [nextDecisions, nextArtifacts, nextGaps] = await Promise.all([
          fetchVoiceCallDecisions(channelId).catch(() => [] as VoiceCallDecisionDTO[]),
          fetchVoiceCallArtifacts(channelId).catch(() => [] as VoiceCallArtifactDTO[]),
          fetchVoiceCallGaps(channelId).catch(() => [] as VoiceCallJournalGapDTO[]),
        ]);
        if (cancelled) return;
        setDecisions(nextDecisions);
        setArtifacts(nextArtifacts);
        setGaps(nextGaps);
      } catch {
        // A read failure must not blank the workspace: the last known state is more useful than an
        // empty one, and the call HUD's own phase copy already says when liveness is unconfirmed.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => setPollTick((tick) => tick + 1), POLL_MS);
    return () => {
      cancelled = true;
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [channelId, pollTick]);

  const refresh = useCallback(() => setPollTick((tick) => tick + 1), []);

  const start = useCallback(() => {
    if (inFlight.current.start) return;
    inFlight.current.start = true;
    setStarting(true);
    setError('');
    void startVoiceCall(channelId)
      .then((next) => {
        if (!aliveRef.current) return;
        setBinding(next);
      })
      .catch((err) => {
        if (!aliveRef.current) return;
        setError(`The call did not start: ${errorText(err)}`);
      })
      .finally(() => {
        inFlight.current.start = false;
        setStarting(false);
        refresh();
      });
  }, [channelId, refresh]);

  const end = useCallback(() => {
    if (inFlight.current.end) return;
    inFlight.current.end = true;
    setEnding(true);
    void endVoiceCall(channelId)
      .then((next) => {
        if (aliveRef.current) setBinding(next);
      })
      .catch((err) => {
        if (aliveRef.current) setError(`The call could not be ended cleanly: ${errorText(err)}`);
      })
      .finally(() => {
        inFlight.current.end = false;
        setEnding(false);
        refresh();
      });
  }, [channelId, refresh]);

  const muted = binding?.micMuted === true;

  const toggleMute = useCallback(() => {
    if (inFlight.current.mute) return;
    inFlight.current.mute = true;
    setMuteBusy(true);
    const next = !muted;
    void setVoiceCallMuted(channelId, next)
      .then((result) => {
        // The daemon's answer is the source of truth for what it ASKED the session — never the
        // click. Reflecting the click optimistically would let a refused mute look successful.
        if (aliveRef.current) setBinding((current) => (current ? { ...current, micMuted: result.muted } : current));
      })
      .catch((err) => {
        if (aliveRef.current) setError(`The mic could not be changed: ${errorText(err)}`);
      })
      .finally(() => {
        inFlight.current.mute = false;
        setMuteBusy(false);
      });
  }, [channelId, muted]);

  const applyOutcome = useCallback((decisionId: string, outcome: ResolveOutcome, optionIndex: number) => {
    if (outcome.kind === 'refused') {
      setRefusals((current) => ({ ...current, [decisionId]: outcome.message }));
      setConfirmPending(undefined);
      return;
    }
    setRefusals((current) => {
      if (!(decisionId in current)) return current;
      const next = { ...current };
      delete next[decisionId];
      return next;
    });
    if (outcome.kind === 'confirm-required') {
      setConfirmPending({ decisionId, optionIndex, label: outcome.label, confirmToken: outcome.confirmToken });
      return;
    }
    setConfirmPending(undefined);
  }, []);

  const chooseOption = useCallback(
    async (decisionId: string, optionIndex: number, label: string): Promise<ResolveOutcome | undefined> => {
      if (inFlight.current.resolve) return undefined;
      inFlight.current.resolve = true;
      setPendingOption({ decisionId, optionIndex });
      try {
        const ack = await resolveVoiceCallDecision(channelId, decisionId, { optionIndex, label });
        const outcome = readResolveAck(ack, label);
        if (aliveRef.current) applyOutcome(decisionId, outcome, optionIndex);
        return outcome;
      } catch (err) {
        // A transport/authorization failure is still a refusal the reader must see, with its own
        // reason rather than a swallowed promise.
        const outcome: ResolveOutcome = { kind: 'refused', reason: 'transport', message: `The answer never reached the session: ${errorText(err)}` };
        if (aliveRef.current) applyOutcome(decisionId, outcome, optionIndex);
        return outcome;
      } finally {
        inFlight.current.resolve = false;
        if (aliveRef.current) setPendingOption(undefined);
        refresh();
      }
    },
    [applyOutcome, channelId, refresh],
  );

  const confirm = useCallback(async (): Promise<ResolveOutcome | undefined> => {
    const held = confirmPending;
    if (!held || inFlight.current.resolve) return undefined;
    inFlight.current.resolve = true;
    setPendingOption({ decisionId: held.decisionId, optionIndex: held.optionIndex });
    try {
      const ack = await resolveVoiceCallDecision(channelId, held.decisionId, { optionIndex: held.optionIndex, label: held.label, confirmToken: held.confirmToken });
      const outcome = readResolveAck(ack, held.label);
      if (aliveRef.current) applyOutcome(held.decisionId, outcome, held.optionIndex);
      return outcome;
    } catch (err) {
      const outcome: ResolveOutcome = { kind: 'refused', reason: 'transport', message: `The confirmation never reached the session: ${errorText(err)}` };
      if (aliveRef.current) applyOutcome(held.decisionId, outcome, held.optionIndex);
      return outcome;
    } finally {
      inFlight.current.resolve = false;
      if (aliveRef.current) setPendingOption(undefined);
      refresh();
    }
  }, [applyOutcome, channelId, confirmPending, refresh]);

  const cancelConfirm = useCallback(() => setConfirmPending(undefined), []);

  const sendSteer = useCallback(
    async (text: string): Promise<boolean> => {
      setSteer({ text, status: 'sending' });
      try {
        await steerVoiceCall(channelId, text);
        // `delivered` appears ONLY here — after the daemon acknowledged the relay. Anything earlier
        // would be the room claiming on the session's behalf.
        if (aliveRef.current) setSteer({ text, status: 'delivered' });
        return true;
      } catch (err) {
        if (aliveRef.current) setSteer({ text, status: 'refused', message: steerRefusalCopy(errorText(err)) });
        return false;
      }
    },
    [channelId],
  );

  const clearSteer = useCallback(() => setSteer(undefined), []);

  return useMemo(
    () => ({
      binding,
      decisions,
      artifacts,
      gaps,
      loading,
      error,
      starting,
      ending,
      muteBusy,
      muted,
      controlsAvailable: binding?.controlsAvailable === true,
      steer,
      refusals,
      pendingOption,
      confirmPending,
      start,
      end,
      toggleMute,
      chooseOption,
      confirm,
      cancelConfirm,
      sendSteer,
      clearSteer,
      refresh,
    }),
    [binding, decisions, artifacts, gaps, loading, error, starting, ending, muteBusy, muted, steer, refusals, pendingOption, confirmPending, start, end, toggleMute, chooseOption, confirm, cancelConfirm, sendSteer, clearSteer, refresh],
  );
}
