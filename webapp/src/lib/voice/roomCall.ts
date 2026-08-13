/**
 * roomCall.ts — every decision the room-native call workspace makes, as pure functions.
 *
 * Concern 03 (plans/voice-orchestrated-room-integration) turns a thread into the one human
 * workspace for a live call. The components that render it are deliberately thin: this module owns
 * the derivations — status precedence, register presentation, retention honesty, the steering state
 * machine, raw-event suppression, artifact grouping — so each is testable without a browser, the
 * same split `callHud.ts` already uses for the PTT lane.
 *
 * The rule running through all of it: say the true thing. A degraded call says the socket is gone.
 * A retention mismatch says the room asked for one thing and the session reports another. Steering
 * says "delivered" only after the daemon acknowledges it. Nothing here ever renders an optimistic
 * claim as an observed fact.
 */

import type {
  VoiceCallArtifactDTO,
  VoiceCallBindingDTO,
  VoiceCallDecisionDTO,
  VoiceCallDecisionOptionDTO,
  VoiceCallJournalGapDTO,
  VoiceCallOrphanDTO,
  VoiceCallRetention,
  VoiceCallState,
  VoiceCallTerminalReason,
} from '../api';
// registerPresentation + withoutRawRoomEvents moved to channelTimeline.ts (concern 25 slice 2b —
// they were card-system code that only HISTORICALLY lived here); re-exported so voice-side
// importers keep one hop.
export { isRawRoomEvent, registerPresentation, withoutRawRoomEvents, type RegisterPresentation } from '../channelTimeline';
import type { ChannelCardRegister } from '../channelTimeline';
import type { ChannelEntry } from '../dto';

// =================================================================================================
// Epistemic register (DESIGN.md addendum — first real emitter is the voice-decision card)
// =================================================================================================


// =================================================================================================
// Call phase chrome — fixed size, honest labels
// =================================================================================================

/**
 * `'checking'` is the honest fifth phase (concern 10: call-management-ui) for the window between
 * mount and the FIRST binding fetch resolving — see `callPhase`'s doc for the production bug this
 * closes: without it, that window rendered as `'none'`, which offered "Start a call" during a
 * refresh mid-call. A click there would race the daemon's own "already has an active call" guard
 * rather than silently starting a duplicate, but the OFFER itself was the dead-end — a person
 * refreshing mid-call saw no attached call and no End/Mute controls, exactly the production
 * observation this concern's Goal names.
 */
export type CallPhase = VoiceCallState | 'none' | 'checking';

/**
 * The phase word. Deliberately short and, crucially, RESERVED to a constant width by the caller —
 * surfaces reserve a fixed label width so chrome never reflows as a call moves through
 * connecting → live → degraded → ended. A control row that resizes under the pointer is a control
 * row you mis-click.
 */
export const PHASE_LABEL: Record<CallPhase, string> = {
  none: 'no call',
  checking: 'checking',
  connecting: 'connecting',
  live: 'live',
  degraded: 'degraded',
  ended: 'ended',
};

/**
 * The phase the HUD should render, honest about what is actually known yet.
 *
 * `binding === null` is ambiguous by itself: it means either "confirmed — no call has ever bound
 * this thread" (the initial REST read already resolved, and there truly is none) or "not confirmed
 * yet — the first read is still in flight" (a fresh mount, e.g. a page refresh mid-call). Only
 * `loading` tells the two apart. Rendering the first read's pending window as `'none'` is the
 * refresh-rehydration defect concern 10 exists to close: the HUD offered "Start a call" during that
 * window, which is both a false "no call here" claim and an invitation to race the daemon's own
 * single-active-call guard the moment the real (possibly live) binding arrives a beat later.
 */
export function callPhase(binding: VoiceCallBindingDTO | null, loading: boolean): CallPhase {
  if (binding) return binding.state;
  return loading ? 'checking' : 'none';
}

/** Honest end-of-call copy, one sentence per terminal reason. Mirrors the daemon's own taxonomy
 *  (`voice-call-manager.ts#terminalReasonDetail`) in the room's voice rather than the log's. */
export function terminalReasonCopy(reason: VoiceCallTerminalReason | undefined, terminalError?: string | null): string {
  switch (reason) {
    case 'operator-ended':
      return 'You ended this call.';
    case 'terminal':
      return terminalError ? `The session ended with an error: ${terminalError}` : 'The session ended cleanly.';
    case 'journal-end':
      return 'The session stopped without writing a clean ending — it most likely crashed.';
    case 'broker-exit':
      return 'The call broker confirmed the session process exited.';
    case 'stale-binding':
      return 'This call could not be confirmed alive after the daemon restarted, so it is treated as ended rather than claiming it is still running.';
    case 'port-reused':
      return 'A different session took over this call’s port. The room refused to adopt it as a continuation.';
    case 'start-failed':
      return 'The call never started.';
    case 'idle':
      // Duration-free deliberately: the idle-hangup window is env-overridable
      // (OMP_COVEN_IDLE_HANGUP_MS) and the binding does not carry the value that
      // was actually configured for this call, so naming a fixed number here
      // would drift from reality the moment an operator changes it.
      return 'The call ended after sitting idle with no one speaking.';
    default:
      return 'The call ended.';
  }
}

/** `true` when a call ended in a way nobody chose — the one terminal case the status region raises
 *  rather than files away. An operator-ended call, the idle-hangup policy doing exactly what it was
 *  configured to do, and a clean session exit are all normal — not surprises to raise. */
export function endedUnexpectedly(binding: VoiceCallBindingDTO | null): boolean {
  if (!binding || binding.state !== 'ended') return false;
  if (binding.terminalReason === 'operator-ended' || binding.terminalReason === 'idle') return false;
  if (binding.terminalReason === 'terminal') return Boolean(binding.terminalError);
  return true;
}

// =================================================================================================
// Recording / retention — visible at call start (concern 05: default `full`)
// =================================================================================================

export const RETENTION_LABEL: Record<VoiceCallRetention, string> = {
  full: 'Recording in full',
  tails: 'Recording tails only',
  off: 'Not recording',
};

export interface RetentionNotice {
  label: string;
  detail: string;
  /** `true` when the session's own reported mode disagrees with what the room asked for. The HUD
   *  raises this rather than showing the requested mode as though it were in force. */
  mismatch: boolean;
}

/**
 * What the recording state actually is, said at call start (DESIGN.md: "A thread-bound call starts
 * with a visible recording/retention state").
 *
 * The honesty that matters is `retentionMismatch`: the daemon ASKS the broker for a retention mode
 * and the session REPORTS what it actually did. When those disagree, the room shows the reported
 * mode as the operative one and names the disagreement — the alternative is a room that says
 * "recording in full" over a session journaling tails, which is exactly the invisible privacy
 * expansion DESIGN.md's risk table exists to prevent.
 */
export function retentionNotice(binding: VoiceCallBindingDTO): RetentionNotice {
  const mismatch = binding.retentionMismatch;
  if (mismatch) {
    return {
      label: RETENTION_LABEL[mismatch.reported],
      detail: `This room asked for "${mismatch.expected}" and the session reports "${mismatch.reported}". What the session reports is what is happening — the room cannot overrule it, only tell you.`,
      mismatch: true,
    };
  }
  const detail =
    binding.retention === 'full'
      ? 'The full conversation is kept in this thread as the durable record. You can end the call at any time; the record stays scoped to this room.'
      : binding.retention === 'tails'
        ? 'Only the tail of each turn is kept. Expanding a clipped turn is not possible for this call.'
        : 'Nothing spoken is being written to the record.';
  return { label: RETENTION_LABEL[binding.retention], detail, mismatch: false };
}

// =================================================================================================
// Idle policy (concern 05: 10-minute idle hangup, spoken warning at ~9 minutes)
// =================================================================================================
/** The recorded 10-minute idle-hangup policy value (OMP_COVEN_IDLE_HANGUP_MS default) — a POLICY
 *  MIRROR, not display code: tests/voice-spine-policy.test.ts pins it cross-tree (concern 05
 *  default #2). RESTORED after slice 2a wrongly swept it with the hud display helpers (the root
 *  policy suite caught it — grok's dying narration had flagged exactly this). */
export const IDLE_HANGUP_MS = 10 * 60 * 1000;

/** Which decision classes the room refuses to resolve by voice (concern 05: destructive/outward
 *  actions are UI-only). Everything else is voice-resolvable through read-back plus confirmation. */
export const UI_ONLY_DECISION_NOTE = 'Merging, publishing, spending and deleting are answered here, by hand — never by voice.';

const UI_ONLY_PATTERN = /\b(merge[sd]?|merging|publish(?:es|ed|ing)?|deploy(?:s|ed|ing)?|releas(?:e|es|ed|ing)|spend(?:s|ing)?|pay(?:s|ment)?|charge[sd]?|delete[sd]?|deleting|destroy(?:s|ed|ing)?|drop(?:s|ped|ping)?|revoke[sd]?|force[- ]push)\b/i;

/**
 * Whether a decision falls in the UI-only class.
 *
 * The wire NOW carries a class field (`decisionClass`, concern 05's mechanism) — the arbiter itself
 * enforces it, refusing a voice resolve outright, so when it is present it is a FACT, not a guess,
 * and takes precedence unconditionally: `"destructive"` is UI-only, `"routine"` is not, even if the
 * text pattern below would have guessed the opposite either way. Only a CLASSLESS decision (one
 * minted before a caller declared one) falls back to reading the decision's own words — still a
 * CONSERVATIVE heuristic whose only effect is to add a warning line, never to hide an option or
 * block an answer, exactly as before this field existed.
 */
export function isUiOnlyDecision(decision: Pick<VoiceCallDecisionDTO, 'prompt' | 'options' | 'decisionClass'>): boolean {
  if (decision.decisionClass !== undefined) return decision.decisionClass === 'destructive';
  if (UI_ONLY_PATTERN.test(decision.prompt)) return true;
  return decision.options.some((option) => UI_ONLY_PATTERN.test(option.label) || UI_ONLY_PATTERN.test(option.consequence));
}

/**
 * Whether `isUiOnlyDecision`'s answer came from the wire's own `decisionClass` (a fact the arbiter
 * enforces) or from the text heuristic (a guess that only ever adds a warning). The decision door
 * renders these two differently — a fact in the daemon's `"checked"` register, a guess in the same
 * hedged copy it always used — so this needs to be observable, not just folded into one boolean.
 */
export type UiOnlyDecisionSource = 'wire' | 'heuristic';

export function uiOnlyDecisionSource(decision: Pick<VoiceCallDecisionDTO, 'decisionClass'>): UiOnlyDecisionSource {
  return decision.decisionClass === undefined ? 'heuristic' : 'wire';
}

// =================================================================================================
// Decision door — what the panel renders, derived from daemon-projected state
// =================================================================================================

export type DecisionUrgency = 'urgent' | 'review' | 'settled';

/**
 * How urgently one decision needs a person, mirroring the daemon's own ladder mapping
 * (`src/voice-attention.ts#voiceDecisionLadderPriority`: `awaiting-confirmation` →
 * `pending-approval`, `open` → `awaiting-input`, anything terminal → nothing at all).
 *
 * The room adds ONE rule the ladder does not need: an `open` decision that requires confirmation is
 * urgent too, because the agent is already blocked on a two-step answer. Everything else that is
 * merely open groups into the review queue rather than interrupting.
 */
export function decisionUrgency(decision: Pick<VoiceCallDecisionDTO, 'state' | 'requiresConfirmation'>): DecisionUrgency {
  if (decision.state === 'awaiting-confirmation') return 'urgent';
  if (decision.state === 'open') return decision.requiresConfirmation ? 'urgent' : 'review';
  return 'settled';
}

export function isDecisionResolved(decision: Pick<VoiceCallDecisionDTO, 'state'>): boolean {
  return decision.state !== 'open' && decision.state !== 'awaiting-confirmation';
}

/**
 * The agent's recommendation, if it made one.
 *
 * The wire has no `recommended` flag — `VoiceCallDecisionOptionDTO` is index/label/consequence and
 * nothing else. So the only honest source is the agent's own words, which is precisely why the
 * recommendation renders as a CLAIM and is never pre-selected: the room is repeating what the agent
 * said, not endorsing it. Recognised markers are an explicit parenthetical or a leading
 * "recommended" in the consequence; anything vaguer is not treated as a recommendation at all,
 * because inventing one would be worse than showing none.
 */
const RECOMMENDATION_MARKER = /\((?:recommended|recommend)\)|\[(?:recommended|recommend)\]|(?:^|[—–-]\s*)recommended\b/i;

export function recommendedOptionIndex(options: readonly VoiceCallDecisionOptionDTO[]): number | undefined {
  const found = options.findIndex((option) => RECOMMENDATION_MARKER.test(option.label) || RECOMMENDATION_MARKER.test(option.consequence));
  return found < 0 ? undefined : options[found]!.index;
}

/** The option label with any recommendation marker stripped, so the badge says it once instead of
 *  the label saying it a second time in parentheses. */
export function optionLabelWithoutMarker(label: string): string {
  return label.replace(/\s*[([](?:recommended|recommend)[)\]]\s*/i, ' ').replace(/\s{2,}/g, ' ').trim();
}

export interface DecisionDoorOption {
  index: number;
  label: string;
  consequence: string;
  /** Visible as advice. NEVER a default, a pre-check, or an autofocus — see the door component. */
  recommended: boolean;
}

export interface DecisionDoorModel {
  id: string;
  question: string;
  /** Register for the question text. Always `claim`: the question is the agent's own account. */
  register: ChannelCardRegister;
  options: DecisionDoorOption[];
  requiresConfirmation: boolean;
  urgency: DecisionUrgency;
  resolved: boolean;
  /** Copy for the state chrome — daemon-observed, never the agent's words. */
  stateLine: string;
  /** `true` while the daemon is holding a first answer and waiting for the confirming second act. */
  awaitingConfirmation: boolean;
  /** Set once resolved: what was chosen and who chose it. */
  resolution?: { label: string; source: 'voice' | 'ui' };
  uiOnly: boolean;
  /** Whether `uiOnly` is a wire-declared fact (the arbiter enforces it) or the text heuristic's
   *  guess. The door renders the two differently — see `uiOnlyDecisionSource`'s doc. */
  uiOnlySource: UiOnlyDecisionSource;
}

/** Daemon-observed state, in words. This is CHROME — it never carries the agent's register. */
export function decisionStateLine(decision: VoiceCallDecisionDTO): string {
  switch (decision.state) {
    case 'open':
      return decision.requiresConfirmation ? 'Open — answering it asks you to confirm.' : 'Open.';
    case 'awaiting-confirmation':
      return 'Waiting for you to confirm the answer you gave.';
    case 'answered':
      return decision.resolution ? `Answered ${decision.resolution.source === 'voice' ? 'by voice' : 'here'}.` : 'Answered.';
    case 'expired':
      return 'Expired — the call ended before it was answered.';
    case 'cancelled':
      return 'Cancelled by the agent.';
    case 'failed':
      return 'Failed — the arbiter could not record an answer.';
  }
}

export function decisionDoorModel(decision: VoiceCallDecisionDTO): DecisionDoorModel {
  const recommended = recommendedOptionIndex(decision.options);
  return {
    id: decision.id,
    question: decision.prompt,
    register: 'claim',
    options: decision.options.map((option) => ({
      index: option.index,
      label: optionLabelWithoutMarker(option.label),
      consequence: option.consequence,
      recommended: option.index === recommended,
    })),
    requiresConfirmation: decision.requiresConfirmation,
    urgency: decisionUrgency(decision),
    resolved: isDecisionResolved(decision),
    stateLine: decisionStateLine(decision),
    awaitingConfirmation: decision.state === 'awaiting-confirmation',
    resolution: decision.resolution ? { label: decision.resolution.label, source: decision.resolution.source } : undefined,
    uiOnly: isUiOnlyDecision(decision),
    uiOnlySource: uiOnlyDecisionSource(decision),
  };
}

/**
 * What the daemon's resolve response actually means, in the room's words.
 *
 * `POST .../resolve` returns the bridge's own `controlAck`: a 200 whose body may still say `ok:
 * false`. That is the arbiter refusing, not the network failing, and the difference matters — a
 * competing resolution must report its real reason rather than a generic "try again".
 */
export type ResolveOutcome =
  | { kind: 'confirm-required'; confirmToken?: string; label: string }
  | { kind: 'resolved'; label: string }
  | { kind: 'refused'; reason: string; message: string };

const ARBITER_REASON_COPY: Record<string, string> = {
  'label-mismatch': 'The arbiter saw a different label than the one on this button — the options changed while it was open. Reload the question and answer the version the agent is actually asking.',
  'already-terminal': 'This was already resolved. Someone else answered it, or the call ended before your answer landed.',
  'already-answered': 'This was already answered — the first answer is the one that counts.',
  'ack-timeout': 'The session never acknowledged the answer. It is not recorded; nothing was sent twice.',
  'bridge-unavailable': 'There is no live socket to the session right now, so the answer could not be relayed.',
  'no-active-call': 'This call has ended, so its questions can no longer be answered.',
  forbidden: 'You do not have permission to answer questions in this room.',
  'confirm-required': 'Confirm the answer to record it.',
  'confirm-token-mismatch': 'That confirmation did not match the answer it belongs to. Answer again from the top.',
};

export function resolveOutcomeCopy(reason: string | undefined): string {
  if (!reason) return 'The session refused the answer and did not say why.';
  return ARBITER_REASON_COPY[reason] ?? `The session refused the answer: ${reason}`;
}

/** Interprets one `resolveVoiceCallDecision` response into the door's next state. */
export function readResolveAck(ack: { ok: boolean; reason?: string; confirmToken?: string }, label: string): ResolveOutcome {
  if (ack.ok) return { kind: 'resolved', label };
  if (ack.confirmToken || ack.reason === 'confirm-required') return { kind: 'confirm-required', confirmToken: ack.confirmToken, label };
  return { kind: 'refused', reason: ack.reason ?? 'unknown', message: resolveOutcomeCopy(ack.reason) };
}

// =================================================================================================
// Composer steering — delivered only after acknowledgement
// =================================================================================================

export type SteerStatus = 'sending' | 'delivered' | 'refused';

export interface SteerState {
  text: string;
  status: SteerStatus;
  /** Present only on `refused` — the daemon's own reason, mapped to a sentence. */
  message?: string;
}

const STEER_REASON_COPY: Record<string, string> = {
  'no-active-call': 'There is no live call in this thread, so there was nothing to steer. What you typed is still in the room as a message.',
  'bridge-unavailable': 'The call has no live socket right now, so the session never heard this. It is in the room as a message, and nothing was queued behind your back.',
  forbidden: 'You do not have permission to steer this call.',
};

/**
 * `true` when a `startVoiceCall` failure is the daemon's own "a session is already running" guard
 * (`CallBindingStore#beginConnecting`'s exact wording: `channel ${id} already has an active call
 * (${state})`) rather than a genuine broker/bridge failure.
 *
 * Concern 10 (call-management-ui): this is NOT a dead end — the channel already has a binding, and
 * `useRoomCall`'s own `start()` already re-polls immediately afterward (its `finally` calls
 * `refresh()`), so the REAL binding (with its real End/Reattach controls) is one poll away. Leaving
 * the raw conflict string up as a persistent error banner under those now-working controls would be
 * exactly the "dead-end string" the concern's Goal names — so `useRoomCall` suppresses it instead of
 * showing it, once it recognises this specific shape.
 */
export function isCallConflictError(message: string): boolean {
  return message.includes('already has an active call');
}

export function steerRefusalCopy(reason: string | undefined): string {
  if (!reason) return 'The daemon refused to relay this to the call and did not say why. The session did not hear it.';
  const key = Object.keys(STEER_REASON_COPY).find((candidate) => reason.includes(candidate));
  return key ? STEER_REASON_COPY[key]! : `The daemon refused to relay this to the call: ${reason}. The session did not hear it.`;
}

/** The line beside a steered message. `sending` never claims delivery — that word appears only once
 *  the daemon has acknowledged the relay. */
export function steerStatusLine(state: SteerState | undefined): string {
  if (!state) return '';
  if (state.status === 'sending') return 'Sending to the call…';
  if (state.status === 'delivered') return 'Delivered to the call.';
  return state.message ?? steerRefusalCopy(undefined);
}

/** Whether the composer should attempt to steer at all. Mention semantics are untouched: an
 *  addressed mention is a FLEET instruction and keeps going to the fleet, exactly as before. */
export function shouldSteer(args: { callState: VoiceCallState | undefined; mentionRoute: string; text: string }): boolean {
  if (!args.text.trim()) return false;
  if (args.mentionRoute !== 'none') return false;
  return args.callState === 'live' || args.callState === 'degraded';
}

// =================================================================================================
// Raw activity suppression — `yield`, heartbeats, empty completions never render
// =================================================================================================



// =================================================================================================
// Thread-scoped status region
// =================================================================================================

export type ThreadStatusKind = 'no-call' | 'ended-unexpectedly' | 'retention-mismatch' | 'degraded' | 'open-decisions' | 'review-queue' | 'active-agents' | 'all-clear';

export interface ThreadStatus {
  kind: ThreadStatusKind;
  /** One line, the whole point of the region. */
  headline: string;
  /** The second line, when there is genuinely more to say. */
  detail?: string;
  /** Severity, for the rule colour. Mirrors the timeline's own tone vocabulary. */
  tone: 'neutral' | 'info' | 'warning' | 'destructive' | 'success';
  /** How many things of this kind — drives the count chip, `0` when a count is meaningless. */
  count: number;
}

export interface ThreadStatusInput {
  binding: VoiceCallBindingDTO | null;
  decisions: readonly VoiceCallDecisionDTO[];
  /** Fleet units currently working in this thread. Not voice-specific: "active agents" is a fact
   *  about the room, and the region answers for the room. */
  activeAgents: number;
  gaps?: readonly VoiceCallJournalGapDTO[];
}

/**
 * The one status line the thread shows, chosen by strict precedence rather than by stacking
 * badges. The order is what a person needs first:
 *
 *   ended-unexpectedly → degraded → open decisions → review queue → active agents → all clear
 *
 * `no-call` sits outside the ladder: with no binding there is no call to have a state.
 *
 * Note the deliberate ordering of degraded ABOVE open decisions. A decision you cannot answer
 * because the socket is gone is not "a question waiting" — it is a broken relay, and saying so
 * first is what stops someone clicking an option four times.
 */
export function threadStatus(input: ThreadStatusInput): ThreadStatus {
  const { binding, decisions, activeAgents } = input;
  const gaps = input.gaps ?? [];
  if (!binding) {
    return { kind: 'no-call', headline: 'No call in this thread.', detail: 'Start one and the conversation, decisions and artifacts all land here.', tone: 'neutral', count: 0 };
  }
  if (endedUnexpectedly(binding)) {
    return { kind: 'ended-unexpectedly', headline: 'The call ended unexpectedly.', detail: terminalReasonCopy(binding.terminalReason, binding.terminalError), tone: 'destructive', count: 0 };
  }
  // Retention mismatch outranks everything but a dead call (codex H, concern 25 round): the room
  // asked for one recording posture and the live session reports another — a privacy/trust fact.
  // The daemon's durable mismatch CARD scrolls away with the timeline; this standing region was
  // saying "All clear" over it. The deleted call HUD was the only alert renderer; the precedence
  // ladder is its honest replacement on the surface that actually stands.
  if (binding.retentionMismatch && binding.state !== 'ended') {
    return {
      kind: 'retention-mismatch',
      headline: `Recording mismatch: the room asked for "${binding.retentionMismatch.expected}" but the live session reports "${binding.retentionMismatch.reported}".`,
      detail: 'What is actually being kept follows the SESSION, not the room setting. End the call if the reported posture is not acceptable.',
      tone: 'destructive',
      count: 0,
    };
  }
  if (binding.state === 'degraded') {
    return { kind: 'degraded', headline: 'The live view is degraded.', detail: 'The socket dropped and the room is confirming with the broker whether the session is still running. The record is unaffected — it comes from the journal, not this socket.', tone: 'warning', count: 0 };
  }
  const urgent = decisions.filter((decision) => decisionUrgency(decision) === 'urgent');
  if (urgent.length > 0) {
    return {
      kind: 'open-decisions',
      headline: urgent.length === 1 ? 'One decision is waiting on you.' : `${urgent.length} decisions are waiting on you.`,
      detail: urgent[0]!.prompt,
      tone: 'warning',
      count: urgent.length,
    };
  }
  const review = decisions.filter((decision) => decisionUrgency(decision) === 'review');
  if (review.length > 0) {
    return {
      kind: 'review-queue',
      headline: review.length === 1 ? 'One question is in the review queue.' : `${review.length} questions are in the review queue.`,
      detail: 'None of them is blocking. Answer them when you get to them.',
      tone: 'info',
      count: review.length,
    };
  }
  if (activeAgents > 0) {
    return {
      kind: 'active-agents',
      headline: activeAgents === 1 ? 'One agent is working.' : `${activeAgents} agents are working.`,
      detail: gaps.length > 0 ? `${gaps.length} gap${gaps.length === 1 ? '' : 's'} in the record — some events were missed and the room says so rather than pretending the history is complete.` : undefined,
      tone: 'info',
      count: activeAgents,
    };
  }
  if (binding.state === 'ended') {
    return { kind: 'all-clear', headline: 'The call ended and nothing is waiting.', detail: terminalReasonCopy(binding.terminalReason, binding.terminalError), tone: 'neutral', count: 0 };
  }
  return { kind: 'all-clear', headline: 'All clear.', detail: 'Nothing is waiting on you and nothing is running.', tone: 'success', count: 0 };
}

// =================================================================================================
// Attention chip + live-region announcement (no focus theft)
// =================================================================================================

/**
 * What the polite live region should say when a decision arrives.
 *
 * `aria-live="polite"` and NOTHING else: no focus move, no scroll, no modal. A question arriving
 * while someone is mid-sentence in the composer must not take the caret — DESIGN.md's do-not-
 * interrupt posture applies to keyboard focus first of all. Returns `undefined` when there is
 * nothing new, so the region renders empty rather than repeating itself.
 */
export function decisionAnnouncement(previousIds: ReadonlySet<string>, decisions: readonly VoiceCallDecisionDTO[]): string | undefined {
  const arrived = decisions.filter((decision) => !previousIds.has(decision.id) && decisionUrgency(decision) !== 'settled');
  if (arrived.length === 0) return undefined;
  if (arrived.length === 1) return `A decision is waiting: ${arrived[0]!.prompt}`;
  return `${arrived.length} decisions are waiting. The first is: ${arrived[0]!.prompt}`;
}

/** The chip's own text — short, because it sits in chrome. `undefined` when nothing is waiting. */
export function attentionChipLabel(decisions: readonly VoiceCallDecisionDTO[]): string | undefined {
  const urgent = decisions.filter((decision) => decisionUrgency(decision) === 'urgent').length;
  const review = decisions.filter((decision) => decisionUrgency(decision) === 'review').length;
  if (urgent > 0) return urgent === 1 ? '1 waiting on you' : `${urgent} waiting on you`;
  if (review > 0) return review === 1 ? '1 to review' : `${review} to review`;
  return undefined;
}

// =================================================================================================
// Artifacts index — current-run grouping, all-agents default, stable order, explicit states
// =================================================================================================

export type ArtifactViewState = 'ready' | 'writing' | 'missing' | 'failed';

export interface ArtifactRow {
  id: string;
  /** Just the filename — the full path stays one hover away, never truncated into meaninglessness. */
  name: string;
  path: string;
  callId: string;
  state: ArtifactViewState;
  /** Which agent produced it, when the path says so. See `artifactAgent`. */
  agent: string;
  revision?: number;
  contentHash?: string;
  error?: string;
  copiedAt: number;
  /** `true` when a later revision of the same path exists — this row is history, not the current file. */
  superseded: boolean;
}

export interface ArtifactGroup {
  callId: string;
  /** `true` for the call currently bound to this thread — the "current run". */
  current: boolean;
  rows: ArtifactRow[];
}

/** The default filter value: every agent. Named rather than `''` so the intent survives a grep. */
export const ALL_AGENTS = 'all';

/**
 * Which agent produced an artifact.
 *
 * The wire carries no agent field — `ArtifactSnapshotRecord` is (channel, call, path, status,
 * hash). The fleet's own worktree convention puts a unit's work under a `squad/<unit>` or
 * `.claude/worktrees/<name>` segment, so when the path says which unit wrote it, the filter uses
 * that. When it does not, the row belongs to `session` — the call itself — rather than being
 * assigned to a guess. A filter that quietly mis-attributes files is worse than one with a single
 * honest bucket.
 */
export function artifactAgent(sourcePath: string): string {
  const segments = sourcePath.split('/').filter(Boolean);
  const worktreeIndex = segments.lastIndexOf('worktrees');
  if (worktreeIndex >= 0 && segments[worktreeIndex + 1]) return segments[worktreeIndex + 1]!;
  const squadIndex = segments.lastIndexOf('squad');
  if (squadIndex >= 0 && segments[squadIndex + 1]) return segments[squadIndex + 1]!;
  return 'session';
}

function artifactState(artifact: VoiceCallArtifactDTO): ArtifactViewState {
  if (artifact.status === 'ready') return 'ready';
  if (artifact.status === 'incomplete') return 'writing';
  // A `failed` record whose error names a vanished source is a MISSING file, not a broken copier —
  // two different things for the reader to do about it, so they read differently.
  if (/enoent|does not exist|is gone/i.test(artifact.error ?? '')) return 'missing';
  return 'failed';
}

export function artifactFileName(sourcePath: string): string {
  const segments = sourcePath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? sourcePath;
}

/**
 * The index, grouped by run with the current run first.
 *
 * Order inside a group is STABLE and content-independent: newest snapshot first, ties broken by
 * path then id. A poll that returns the same rows must never reshuffle them — a list that reorders
 * under a reader is a list they stop trusting, and worse, one whose scroll position means nothing.
 */
export function groupArtifacts(artifacts: readonly VoiceCallArtifactDTO[], currentCallId: string | undefined, agentFilter: string = ALL_AGENTS): ArtifactGroup[] {
  const latestRevisionByPath = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.status !== 'ready') continue;
    const key = `${artifact.callId}\0${artifact.sourcePath}`;
    latestRevisionByPath.set(key, Math.max(latestRevisionByPath.get(key) ?? 0, artifact.revision ?? 0));
  }
  const rows: ArtifactRow[] = artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifactFileName(artifact.sourcePath),
    path: artifact.sourcePath,
    callId: artifact.callId,
    state: artifactState(artifact),
    agent: artifactAgent(artifact.sourcePath),
    revision: artifact.revision,
    contentHash: artifact.contentHash,
    error: artifact.error,
    copiedAt: artifact.copiedAt,
    superseded: artifact.status === 'ready' && (artifact.revision ?? 0) < (latestRevisionByPath.get(`${artifact.callId}\0${artifact.sourcePath}`) ?? 0),
  }));
  const filtered = agentFilter === ALL_AGENTS ? rows : rows.filter((row) => row.agent === agentFilter);
  const byCall = new Map<string, ArtifactRow[]>();
  for (const row of filtered) {
    const list = byCall.get(row.callId);
    if (list) list.push(row);
    else byCall.set(row.callId, [row]);
  }
  const groups: ArtifactGroup[] = [...byCall.entries()].map(([callId, groupRows]) => ({
    callId,
    current: callId === currentCallId,
    rows: groupRows.sort((a, b) => b.copiedAt - a.copiedAt || a.path.localeCompare(b.path) || a.id.localeCompare(b.id)),
  }));
  // Current run first; the rest newest-first by their most recent artifact, id as the final
  // tie-break so the order is total and therefore stable across identical polls.
  return groups.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.rows[0]?.copiedAt ?? 0) - (a.rows[0]?.copiedAt ?? 0) || a.callId.localeCompare(b.callId);
  });
}

/** Every agent that has produced an artifact, for the filter control. `all` always leads. */
export function artifactAgentOptions(artifacts: readonly VoiceCallArtifactDTO[]): string[] {
  const agents = [...new Set(artifacts.map((artifact) => artifactAgent(artifact.sourcePath)))].sort((a, b) => a.localeCompare(b));
  return [ALL_AGENTS, ...agents];
}

/** The empty-state sentence, which differs by why it is empty. "No artifacts" during a live call
 *  and "no artifacts" with no call at all are not the same fact. */
export function artifactEmptyCopy(binding: VoiceCallBindingDTO | null, filtered: boolean): string {
  if (filtered) return 'No artifacts from this agent. Clear the filter to see the rest of the run.';
  if (!binding) return 'No call has run in this thread yet, so nothing has been produced.';
  if (binding.state === 'ended') return 'This run produced no artifacts.';
  return 'Nothing written yet. Files appear here the moment the run snapshots them.';
}

/** Per-row copy for the non-`ready` states, so each one says what to do about it. */
export function artifactStateCopy(row: Pick<ArtifactRow, 'state' | 'error'>): string | undefined {
  if (row.state === 'ready') return undefined;
  if (row.state === 'writing') return 'Still being written — the call ended before this one was snapshotted.';
  if (row.state === 'missing') return row.error ?? 'The file the run named was not there when the room went to copy it.';
  return row.error ?? 'The room could not copy this file, so there is no snapshot to show.';
}

// =================================================================================================
// Narrow screens — a single-pane back stack that keeps scroll and filter
// =================================================================================================

/**
 * `'transcript'` (concern 11) and `'calls'` (concern 10) join the existing back-stack — the SAME
 * `pushPane`/`popPane`/`currentPane`/`reconcileArtifactPane` machinery below is already generic over
 * `WorkspacePane`, so neither concern needed a second navigation model or a differently-named panel
 * slot; they are one more branch in the same stack.
 */
export type WorkspacePane = 'conversation' | 'decision' | 'artifacts' | 'artifact' | 'transcript' | 'calls';

/**
 * The back stack for a single-pane (narrow) layout.
 *
 * Wide screens show conversation and panel side by side; narrow screens show ONE, and Escape or
 * Back returns to the previous pane rather than dumping the reader at the conversation. The stack
 * is data, so the scroll offsets and the artifact filter ride along with it and are restored on the
 * way back — a filter you have to re-apply after every drill-in is a filter you stop using.
 */
export interface PaneStackEntry {
  pane: WorkspacePane;
  /** Restored on return. */
  scrollTop: number;
  /** Only meaningful on the artifacts pane; carried on every entry so restore needs no branch. */
  agentFilter: string;
  /** The artifact being read, on the `artifact` pane. */
  artifactId?: string;
}

export function initialPaneStack(): PaneStackEntry[] {
  return [{ pane: 'conversation', scrollTop: 0, agentFilter: ALL_AGENTS }];
}

/** Push a pane, recording where the CURRENT pane was left. Re-pushing the pane already on top is a
 *  no-op (beyond the scroll record) rather than a duplicate stack entry. */
export function pushPane(stack: readonly PaneStackEntry[], next: Omit<PaneStackEntry, 'scrollTop'>, currentScrollTop: number): PaneStackEntry[] {
  const withScroll = stack.map((entry, index) => (index === stack.length - 1 ? { ...entry, scrollTop: currentScrollTop } : entry));
  const top = withScroll[withScroll.length - 1];
  if (top && top.pane === next.pane && top.artifactId === next.artifactId) return withScroll;
  return [...withScroll, { ...next, scrollTop: 0 }];
}

/** Pop back one pane. The root conversation pane can never be popped — there is nothing behind it,
 *  and an Escape that empties the screen is worse than one that does nothing. */
export function popPane(stack: readonly PaneStackEntry[]): PaneStackEntry[] {
  return stack.length <= 1 ? [...stack] : stack.slice(0, -1);
}

export function currentPane(stack: readonly PaneStackEntry[]): PaneStackEntry {
  return stack[stack.length - 1] ?? initialPaneStack()[0]!;
}

/** Setting the filter updates every entry, not only the visible one: the filter is a property of
 *  the workspace, so drilling into an artifact and coming back must not resurrect the old value. */
export function setStackFilter(stack: readonly PaneStackEntry[], agentFilter: string): PaneStackEntry[] {
  return stack.map((entry) => ({ ...entry, agentFilter }));
}

/**
 * If the stack's top is an `artifact` pane pointing at an id `artifactRowById` no longer has — the
 * call ended and a later poll pruned the row, or a restored stack points at an id that was never
 * fetched — HubShell's `voicePanel` derivation renders nothing for it, but the phantom entry stays
 * on top of the stack. That is worse than an empty panel: Escape and the panel's own Back control
 * have nothing left behind them to return to, so they silently stop doing anything.
 *
 * Returns `stack` itself (same reference) when there is nothing to reconcile, so a caller wiring
 * this into a `setState` updater never triggers a re-render loop over a no-op.
 */
export function reconcileArtifactPane(stack: PaneStackEntry[], artifactRowById: ReadonlyMap<string, ArtifactRow>): PaneStackEntry[] {
  const top = currentPane(stack);
  if (top.pane === 'artifact' && top.artifactId && !artifactRowById.has(top.artifactId)) return popPane(stack);
  return stack;
}

/**
 * What pressing a `voice-call` card's "Open the call" door actually does.
 *
 * The HUD is rendered in `ChannelTimeline`'s `header`, which HubShell pins above the scroller in the
 * room's always-visible fixed frame — it is never off-screen, so `scrollIntoView` alone is a no-op
 * there and the door looked like it did nothing. Moving focus into the region is the part a
 * keyboard or assistive-technology user can actually perceive. `scrollIntoView` stays, guarded by
 * `?.`, for the one case it is not a no-op — a layout where the HUD genuinely can scroll off — where
 * it is harmless alongside the focus move.
 */
export function focusHudRegion(node: { focus: () => void; scrollIntoView?: (options?: ScrollIntoViewOptions) => void } | null | undefined): void {
  if (!node) return;
  node.scrollIntoView?.({ block: 'nearest' });
  node.focus();
}

// =================================================================================================
// Browser audio transport (concern 09) — a device-audio call has NOTHING to show here; the line
// only exists once `useRoomCallAudio` actually opened a relay (its `relayStatus` starts 'idle' for
// exactly that case, matched below).
// =================================================================================================

export type BrowserAudioMicStatus = 'idle' | 'requesting' | 'active' | 'denied';
export type BrowserAudioRelayStatus = 'idle' | 'connecting' | 'ready' | 'refused' | 'closed';

export interface BrowserAudioStatusLine {
  text: string;
  tone: 'neutral' | 'error';
  /** Whether the HUD should offer a retry affordance — every error state does; a transient
   *  "connecting"/"requesting" line does not, since there is nothing to retry yet. */
  showRetry: boolean;
}

/**
 * What the HUD's browser-audio status line should say, for one snapshot of `useRoomCallAudio`'s
 * own state. Pure and exhaustive over every `(micStatus, relayStatus)` pair this hook can actually
 * produce, so the render layer never has to guess at a combination this function doesn't cover.
 */
export function browserAudioStatusLine(input: { micStatus: BrowserAudioMicStatus; relayStatus: BrowserAudioRelayStatus; error?: string }): BrowserAudioStatusLine | undefined {
  const { micStatus, relayStatus, error } = input;
  if (relayStatus === 'idle') return undefined; // not an audio-less call — nothing to say
  if (relayStatus === 'connecting') return { text: 'Connecting the browser audio relay…', tone: 'neutral', showRetry: false };
  if (relayStatus === 'refused') return { text: error ?? 'The browser audio relay was refused.', tone: 'error', showRetry: true };
  if (relayStatus === 'closed') return { text: error ?? 'The browser audio relay connection was lost.', tone: 'error', showRetry: true };
  // relayStatus === 'ready' from here — the socket is up; what's left is the mic's own state.
  if (micStatus === 'requesting') return { text: 'Requesting microphone access…', tone: 'neutral', showRetry: false };
  if (micStatus === 'denied') return { text: error ?? 'Microphone access was denied.', tone: 'error', showRetry: true };
  if (micStatus === 'active') return { text: 'Browser microphone and speaker connected.', tone: 'neutral', showRetry: false };
  return undefined; // micStatus 'idle' with a ready relay — the brief tick before requesting fires
}

// =================================================================================================
// Calls management surface (concern 10, plans/voice-orchestrated-room-integration/10-call-
// management-ui.md) — every binding this actor can see, across every room, plus every broker
// ORPHAN (a call the broker still lists with no daemon binding at all), each with an honest
// mic-capture register and the actions that actually apply to it.
// =================================================================================================

/**
 * Mic-state honesty, per the register rules the concern's Goal names explicitly: "while any session
 * is capturing, the room shows it (`checked`); a session nobody is attached to gets `unverified`
 * treatment". `controlsAvailable` (daemon-checked: `state==="live" && a connected bridge exists`) is
 * the one fact this can be built from truthfully — it is exactly "is anything actually attached to
 * this call right now", the same precondition every mutating control (mute/steer/resolve/reattach)
 * already requires before it will touch the bridge.
 */
export type CallRowMicState = 'checked' | 'unverified' | 'none';

export function callRowMicState(binding: Pick<VoiceCallBindingDTO, 'state' | 'controlsAvailable'>): CallRowMicState {
  if (binding.state === 'ended') return 'none';
  return binding.controlsAvailable ? 'checked' : 'unverified';
}

export interface CallSurfaceBindingRow {
  kind: 'binding';
  channelId: string;
  state: VoiceCallState;
  callId?: string;
  terminalReason?: VoiceCallTerminalReason;
  micState: CallRowMicState;
  /** The urgent-door case the register rules name: a call that WAS confirmed live and has since
   *  lost that confirmation (`degraded`) — never a brand-new `connecting` call, which is routine and
   *  bounded, not a privacy incident waiting to be noticed. */
  urgent: boolean;
  canEnd: boolean;
  /** Only a `degraded` binding is genuinely reattachable — `connecting` is already mid-flow (nothing
   *  to reattach to yet), `live` already has a working bridge, and `ended` is terminal. */
  canReattach: boolean;
}

export interface CallSurfaceOrphanRow {
  kind: 'orphan';
  callId: string;
  startedAt?: number;
  sessionRoot?: string;
  micState: 'unverified';
  urgent: true;
  canEnd: true;
}

export type CallSurfaceRow = CallSurfaceBindingRow | CallSurfaceOrphanRow;

export function callSurfaceBindingRow(binding: Pick<VoiceCallBindingDTO, 'channelId' | 'state' | 'callId' | 'terminalReason' | 'controlsAvailable'>): CallSurfaceBindingRow {
  const micState = callRowMicState(binding);
  return {
    kind: 'binding',
    channelId: binding.channelId,
    state: binding.state,
    callId: binding.callId,
    terminalReason: binding.terminalReason,
    micState,
    urgent: binding.state === 'degraded' && micState === 'unverified',
    canEnd: binding.state !== 'ended',
    canReattach: binding.state === 'degraded',
  };
}

/** Every orphan is, by construction, a call the broker still lists running with nothing daemon-side
 *  attached to confirm anything about it — always `unverified`, always urgent, End is the only
 *  action (there is no channel/binding to reattach through). */
export function callSurfaceOrphanRow(orphan: Pick<VoiceCallOrphanDTO, 'callId' | 'startedAt' | 'sessionRoot'>): CallSurfaceOrphanRow {
  return { kind: 'orphan', callId: orphan.callId, startedAt: orphan.startedAt, sessionRoot: orphan.sessionRoot, micState: 'unverified', urgent: true, canEnd: true };
}

/** The full surface, bindings first (room-scoped, more actionable) then orphans — a stable, total
 *  order (`channelId`/`callId` as the tie-break) so a poll that returns the same rows never reshuffles
 *  them under a reader, matching `groupArtifacts`'s own ordering discipline. */
export function callSurfaceRows(bindings: readonly Parameters<typeof callSurfaceBindingRow>[0][], orphans: readonly Parameters<typeof callSurfaceOrphanRow>[0][]): CallSurfaceRow[] {
  const bindingRows = bindings.map(callSurfaceBindingRow).sort((a, b) => a.channelId.localeCompare(b.channelId));
  const orphanRows = orphans.map(callSurfaceOrphanRow).sort((a, b) => a.callId.localeCompare(b.callId));
  return [...bindingRows, ...orphanRows];
}

/** One line describing WHY a row needs attention — chrome, not a claim, so it carries no register. */
export function callSurfaceRowDetail(row: CallSurfaceRow): string {
  if (row.kind === 'orphan') return 'The call broker still lists this process running. Nothing in any room can see, end, or reattach to it — only this surface can.';
  if (row.state === 'degraded') return 'The live socket dropped. The room is checking whether the session is still running; Reattach retries the SAME check on demand.';
  if (row.state === 'ended') return row.terminalReason ? terminalReasonCopy(row.terminalReason, undefined) : 'The call ended.';
  if (row.state === 'connecting') return 'Dialling the session.';
  return row.micState === 'checked' ? 'A live socket confirms this call is attached and capturing.' : 'No live socket confirms this call — treat it as unattached until it does.';
}
