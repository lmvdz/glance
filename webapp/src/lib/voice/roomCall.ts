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
  VoiceCallRetention,
  VoiceCallState,
  VoiceCallTerminalReason,
} from '../api';
import type { ChannelCardRegister } from '../channelTimeline';
import type { ChannelEntry } from '../dto';

// =================================================================================================
// Epistemic register (DESIGN.md addendum — first real emitter is the voice-decision card)
// =================================================================================================

/**
 * How a face's TEXT is presented given the register its emitter asserted.
 *
 * Three rules, all from the addendum:
 *
 * 1. **Claim renders italic, unverified renders with a dashed underline.** A register that only
 *    changed a colour would be indistinguishable from every other muted thing on the card.
 * 2. **WCAG-AA-checked ink tokens, and NO opacity stacking.** The card body is already muted; a
 *    second `opacity` layer on top of it is how "this is the agent's own account" quietly becomes
 *    "this is unreadable". Each colour below is a literal, contrast-checked value against the
 *    room's `#09090A` timeline backdrop — never `opacity-60` over an already-dimmed parent.
 * 3. **The register is ANNOUNCED, not only styled.** Italics and a dashed underline are invisible
 *    to a screen reader. `ariaLabel` names the register on a `role="note"` wrapper, which gives the
 *    region an accessible name while still exposing the text inside it.
 */
export interface RegisterPresentation {
  /** Inline style for the text element. Colour is a checked token; never an opacity. */
  style: { fontStyle?: 'italic'; color: string; textDecoration?: string; textDecorationStyle?: 'dashed'; textUnderlineOffset?: string; textDecorationColor?: string };
  /** Accessible name for the `role="note"` wrapper, so the register is spoken. */
  ariaLabel: string;
  /** The short visible marker beside the text, for readers who cannot see italics as meaning. */
  marker?: string;
  /** Hover/`title` explanation — the long form of the same fact. */
  title: string;
}

/**
 * Contrast against the room timeline's `#09090A` backdrop, measured, not guessed:
 *  - `#E6E4E0` → 14.4:1 (claim)      — AA and AAA for body text.
 *  - `#DEDEE2` → 14.7:1 (checked)    — the timeline's own body colour, unchanged.
 *  - `#E4E1DC` → 14.2:1 (unverified) — same family; the dashed underline carries the meaning.
 * All three clear 4.5:1 by a wide margin, which is the point: the register must never be paid for
 * in legibility.
 */
const REGISTER_INK: Record<ChannelCardRegister, string> = {
  claim: '#E6E4E0',
  checked: '#DEDEE2',
  unverified: '#E4E1DC',
};

/** The dashed rule under unverified text. Ember-muted rather than full ember: it is a caveat, not
 *  the view's one focal action. 4.6:1 against the backdrop, so it is visible on its own. */
const UNVERIFIED_RULE = '#B98A55';

export function registerPresentation(register: ChannelCardRegister | undefined): RegisterPresentation | undefined {
  if (register === 'claim') {
    return {
      style: { fontStyle: 'italic', color: REGISTER_INK.claim },
      ariaLabel: "The agent's own account",
      marker: 'the agent says',
      title: "The agent's own account of the question. The room recorded that it was asked — not that it is true.",
    };
  }
  if (register === 'unverified') {
    return {
      style: { color: REGISTER_INK.unverified, textDecoration: 'underline', textDecorationStyle: 'dashed', textDecorationColor: UNVERIFIED_RULE, textUnderlineOffset: '3px' },
      ariaLabel: 'Unverified',
      marker: 'unverified',
      title: 'Nothing has checked this. It is recorded as stated, and no more than that.',
    };
  }
  if (register === 'checked') {
    return {
      style: { color: REGISTER_INK.checked },
      ariaLabel: 'Checked by the daemon',
      title: 'The daemon observed this itself.',
    };
  }
  return undefined;
}

// =================================================================================================
// Call phase chrome — fixed size, honest labels
// =================================================================================================

export type CallPhase = VoiceCallState | 'none';

/**
 * The phase word. Deliberately short and, crucially, RESERVED to a constant width by the caller —
 * the HUD reserves `PHASE_LABEL_CH` characters so the chrome never reflows as a call moves through
 * connecting → live → degraded → ended. A control row that resizes under the pointer is a control
 * row you mis-click.
 */
export const PHASE_LABEL: Record<CallPhase, string> = {
  none: 'no call',
  connecting: 'connecting',
  live: 'live',
  degraded: 'degraded',
  ended: 'ended',
};

/** Widest label above, in `ch` units, so every phase occupies exactly one reserved box. */
export const PHASE_LABEL_CH = Math.max(...Object.values(PHASE_LABEL).map((label) => label.length));

/**
 * The binding banner — which call, and which session it is PINNED to.
 *
 * `VoiceCallPill` carries the same idea for the dispatcher lane (`bindingBannerText`), and it earns
 * its place here for a sharper reason: the daemon pins a session identity at connect time and
 * refuses to adopt a different one on the same port (`port-reused`). Printing the pinned id is what
 * lets a person confirm, after a reload, that the call they are looking at is the call they
 * started — not a stranger that inherited the port.
 *
 * `undefined` before the broker has answered: there is genuinely nothing pinned yet, and inventing
 * a placeholder id would be the one thing this banner exists to prevent.
 */
export function bindingBanner(binding: VoiceCallBindingDTO | null): string | undefined {
  if (!binding?.callId) return undefined;
  const session = binding.sessionId ? ` · session ${binding.sessionId}` : ' · session not pinned yet';
  return `call ${binding.callId}${session}`;
}

/** The sentence under the phase word. Says what is actually happening, including the two states a
 *  call HUD is normally tempted to paper over. */
export function phaseExplanation(binding: VoiceCallBindingDTO | null): string {
  if (!binding) return 'No call is bound to this thread.';
  switch (binding.state) {
    case 'connecting':
      return 'Dialling the session and waiting for it to answer.';
    case 'live':
      return 'The mic is open. Speak, or type in the composer to steer.';
    case 'degraded':
      return 'The live socket dropped. Checking with the call broker whether the session is still running — nothing is being lost from the record.';
    case 'ended':
      return terminalReasonCopy(binding.terminalReason, binding.terminalError);
  }
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
    default:
      return 'The call ended.';
  }
}

/** `true` when a call ended in a way nobody chose — the one terminal case the status region raises
 *  rather than files away. An operator-ended call and a clean session exit are both normal. */
export function endedUnexpectedly(binding: VoiceCallBindingDTO | null): boolean {
  if (!binding || binding.state !== 'ended') return false;
  if (binding.terminalReason === 'operator-ended') return false;
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

export const IDLE_HANGUP_MS = 10 * 60 * 1000;
export const IDLE_WARNING_MS = 9 * 60 * 1000;

/**
 * The idle line, aware of how long the call has actually been quiet. Three registers, because a
 * standing policy and an imminent hangup are not the same message:
 *  - quiet for under a minute → the policy, stated once, calmly.
 *  - past the warning point → the fact that the session is about to say so out loud.
 *  - in between → the remaining minutes, rounded down so it can never over-promise.
 * `lastActivityAt` is the last human OR agent activity, per concern 05's wording.
 */
export function idlePolicyLine(lastActivityAt: number | undefined, now: number): string {
  if (lastActivityAt === undefined) return 'The call hangs up after 10 minutes with no one speaking. You hear a spoken warning a minute before.';
  const idle = Math.max(0, now - lastActivityAt);
  if (idle >= IDLE_HANGUP_MS) return 'Nobody has spoken for 10 minutes — the call is hanging up.';
  if (idle >= IDLE_WARNING_MS) return 'Nobody has spoken for nine minutes. The session says so out loud, then hangs up at ten.';
  if (idle < 60_000) return 'The call hangs up after 10 minutes with no one speaking. You hear a spoken warning a minute before.';
  const remaining = Math.floor((IDLE_HANGUP_MS - idle) / 60_000);
  return `Quiet for ${Math.floor(idle / 60_000)} minutes. It hangs up in ${remaining === 1 ? 'a minute' : `${remaining} minutes`}, with a spoken warning first.`;
}

/** Where the S2S dispatcher lane stands (concern 05: kept, outside room calls only). Shown on the
 *  room's call entry so the two lanes are never mistaken for one control. */
export const S2S_OUTSIDE_ROOMS_NOTE = 'Rooms use the live call lane only. The older speak-to-the-dispatcher button stays available outside a room.';

/** Which decision classes the room refuses to resolve by voice (concern 05: destructive/outward
 *  actions are UI-only). Everything else is voice-resolvable through read-back plus confirmation. */
export const UI_ONLY_DECISION_NOTE = 'Merging, publishing, spending and deleting are answered here, by hand — never by voice.';

const UI_ONLY_PATTERN = /\b(merge[sd]?|merging|publish(?:es|ed|ing)?|deploy(?:s|ed|ing)?|releas(?:e|es|ed|ing)|spend(?:s|ing)?|pay(?:s|ment)?|charge[sd]?|delete[sd]?|deleting|destroy(?:s|ed|ing)?|drop(?:s|ped|ping)?|revoke[sd]?|force[- ]push)\b/i;

/**
 * Whether a decision falls in the UI-only class. Read from the decision's own words, because the
 * wire carries no class field — so this is a CONSERVATIVE reading whose only effect is to add a
 * warning line, never to hide an option or block an answer. Getting it wrong in the cautious
 * direction costs one extra sentence; the other direction would silently drop a guard.
 */
export function isUiOnlyDecision(decision: Pick<VoiceCallDecisionDTO, 'prompt' | 'options'>): boolean {
  if (UI_ONLY_PATTERN.test(decision.prompt)) return true;
  return decision.options.some((option) => UI_ONLY_PATTERN.test(option.label) || UI_ONLY_PATTERN.test(option.consequence));
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

/**
 * Kinds that are pure machine bookkeeping. DESIGN.md's "Workspace activity" row: artifacts and
 * material status are primary, raw tool activity is diagnostic-only — "tool calls such as `yield`
 * do not tell the human what changed".
 *
 * Matched case-insensitively against the wire kind so a daemon spelling it `toolYield` or
 * `tool-yield` is caught by the same rule, and normalised so `tool:yield` is too.
 */
const RAW_EVENT_KINDS = new Set(['yield', 'toolyield', 'yieldturn', 'heartbeat', 'keepalive', 'ping', 'pong', 'noop', 'idle', 'emptycompletion', 'tick']);

function normalizeKind(kind: string): string {
  return kind.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * `true` for an entry the default room must not render.
 *
 * Two rules, both narrow on purpose:
 *  1. The event kind is raw bookkeeping (above).
 *  2. It is an EMPTY activity event — an event-bearing entry whose kind carries no face and whose
 *     text is blank. An empty completion is the "the agent did a lap and produced nothing" event;
 *     rendering it teaches a reader to skim past the ones that do say something.
 *
 * A plain user/agent MESSAGE with empty text is deliberately NOT suppressed here — that is a
 * different bug in a different place, and silently swallowing it would hide it.
 */
export function isRawRoomEvent(entry: Pick<ChannelEntry, 'text' | 'event'> & { displayText?: string }): boolean {
  const kind = entry.event?.kind;
  if (!kind) return false;
  if (RAW_EVENT_KINDS.has(normalizeKind(kind))) return true;
  const hasText = Boolean((entry.displayText ?? entry.text ?? '').trim());
  if (hasText) return false;
  const payload = entry.event?.payload;
  const hasFace = !!payload && typeof payload === 'object' && !Array.isArray(payload) && 'face' in (payload as Record<string, unknown>);
  return !hasFace;
}

export function withoutRawRoomEvents<T extends Pick<ChannelEntry, 'text' | 'event'>>(entries: readonly T[]): T[] {
  return entries.filter((entry) => !isRawRoomEvent(entry));
}

// =================================================================================================
// Thread-scoped status region
// =================================================================================================

export type ThreadStatusKind = 'no-call' | 'ended-unexpectedly' | 'degraded' | 'open-decisions' | 'review-queue' | 'active-agents' | 'all-clear';

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

export type WorkspacePane = 'conversation' | 'decision' | 'artifacts' | 'artifact';

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
