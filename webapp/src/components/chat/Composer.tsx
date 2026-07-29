import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Frown, ImagePlus, Loader2, Mic, MicOff, Paperclip, Pencil, PhoneCall, PhoneOff, Sparkles, ArrowUp, Square, X } from 'lucide-react';
import { apiFetch, jsonInit } from '../../lib/api';
import { isImeComposing, useTriggerMenu, type TriggerSource } from '../../hooks/chat/useTriggerMenu';
import { ComposerStats } from './AgentMetaBar';
import { ModelPicker, type Effort } from './ModelPicker';
import { MentionOverlay } from './MentionOverlay';
import { ImageAnnotator, type Annotation } from './ImageAnnotator';
import {
  captureElementToPng,
  downscaleToPng,
  isRasterImageType,
  joinImagePromptRefs,
  MAX_UPLOAD_BYTES,
  nextImageAttachmentId,
  uploadChatAttachment,
} from '../../lib/imageAttachment';
import { isSpeechRecognitionSupported, startVoiceInput, type VoiceInputSession } from '../../lib/voice/speech';
import { DRAFT_PERSIST_DEBOUNCE_MS, loadDraft, persistDraft, type DraftV1 } from '../../lib/chat/draftStore';
import { VoiceCallButton } from './VoiceCallButton';
import { callPhase } from '../../lib/voice/roomCall';
import type { VoiceCallBindingDTO } from '../../lib/api';
import type { AgentDTO } from '../../lib/dto';
import { buildMentionSections, expandMentionTokens, flattenMentionSections, mentionLabel, mentionToken, type MentionTarget } from '../../lib/mentionGrammar';
import type { Task } from '../../types';

// Declared state-relocation (concern 09 — monolith split, DESIGN.md "Monolith
// split" decision): unlike the other pure moves in this concern, `Composer`
// doesn't just relocate JSX — it takes over ownership of the composer's
// `input` state and the `@`-mention trigger-menu wiring from `AssistantChat`.
// The parent keeps `handleSend`'s context-assembly (fleet snapshot, task
// context, agent creation) and calls it via the `onSend` prop once this
// component has already validated and cleared its own input.

export interface ModelOption {
  label: string;
  value: string;
  /** Which harness offers this model. Declared by the daemon, never inferred from the id. */
  harness?: string;
  /** Where the daemon learned of it — "live-probe" (cold harness enumeration) or "static-catalog"
   *  (registry fallback). Absent on env/default/live-agent entries. Informational; rendering never
   *  branches on it. */
  provenance?: string;
}

export interface SuggestionChip {
  label: string;
  prompt: string;
}

// =============================================================================
// Pure decision functions — unit-tested directly (bun:test, no jsdom). Wired
// into the component below via plain useState/useEffect.
// =============================================================================

/** Textarea auto-grow cap: ~8 lines of the composer's 13px/leading-relaxed text plus its
 *  vertical padding (8 * 19.5px + 20px padding ≈ 176px), then it scrolls instead of growing. */
export const COMPOSER_MAX_HEIGHT_PX = 176;

export function clampGrownHeight(scrollHeight: number, max = COMPOSER_MAX_HEIGHT_PX): number {
  return Math.min(scrollHeight, max);
}

/** History recall: -1 means "viewing the live draft" (not recalling); otherwise an index into
 *  `history` (0 = newest). `draft` is the in-progress text saved when recall started, restored
 *  when cycling back past index 0 — terminal convention. */
export interface HistoryRecallState {
  index: number;
  draft: string;
}

export const INITIAL_RECALL_STATE: HistoryRecallState = { index: -1, draft: '' };

export const PROMPT_HISTORY_LIMIT = 50;

/** Newest-first insert, capped — called once per successful send. */
export function pushPromptHistory(history: string[], text: string, limit = PROMPT_HISTORY_LIMIT): string[] {
  return [text, ...history].slice(0, limit);
}

export interface RecallResult {
  state: HistoryRecallState;
  value: string;
}

/** ArrowUp: step one entry further back in history. Saves the live draft on the first step;
 *  returns null at the oldest entry (or when there is no history) so the caller lets the
 *  keystroke fall through to normal caret movement. */
export function recallOlder(state: HistoryRecallState, history: string[], currentDraft: string): RecallResult | null {
  if (history.length === 0) return null;
  if (state.index >= history.length - 1) return null;
  const index = state.index + 1;
  const draft = state.index === -1 ? currentDraft : state.draft;
  return { state: { index, draft }, value: history[index] };
}

/** ArrowDown: step one entry newer. From index 0, restores the saved draft and exits recall.
 *  Returns null when already at the draft (nothing newer to go to). */
export function recallNewer(state: HistoryRecallState, history: string[]): RecallResult | null {
  if (state.index === -1) return null;
  if (state.index === 0) return { state: INITIAL_RECALL_STATE, value: state.draft };
  const index = state.index - 1;
  return { state: { index, draft: state.draft }, value: history[index] };
}

/** Paste-as-chip: a paste past this length becomes an attachment chip instead of flooding the
 *  textarea. 200 chars is comfortably past a normal sentence but well under a pasted diff/log. */
export const PASTE_CHIP_THRESHOLD = 200;

export function shouldChipPaste(text: string, threshold = PASTE_CHIP_THRESHOLD): boolean {
  return text.length > threshold;
}

export function formatPasteSize(byteLength: number): string {
  return `${(byteLength / 1024).toFixed(1)} KB`;
}

export function pasteChipLabel(text: string): string {
  return `Pasted text · ${formatPasteSize(new TextEncoder().encode(text).length)}`;
}

/** Explain why a selected file cannot be attached before it disappears from the picker/drop zone. */
export function imageAttachmentError(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (!isRasterImageType(file.type)) {
    return `${file.name || 'That file'} is not a supported image. Attach a PNG, JPEG, GIF, WebP, or another raster image instead.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name || 'That image'} is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Images must be 4 MB or smaller before upload.`;
  }
  return null;
}

/**
 * Suggestion-chip click: insert, never auto-send. Filling only when the
 * composer is empty is the least-surprising rule — a chip click must not
 * wipe an in-progress draft, nor should it fold an unrelated suggestion into
 * whatever the user is mid-typing. When there's already a draft, the chip
 * click is a no-op on the text (the caller still focuses the textarea).
 */
export function applySuggestionChip(currentInput: string, prompt: string): string {
  return currentInput.trim() === '' ? prompt : currentInput;
}

export interface PasteChip {
  id: string;
  label: string;
  content: string;
}

/**
 * An attached image (paste/drop/capture — Feature 2 D2), always the already-downscaled PNG data
 * URL (see imageAttachment.ts's `downscaleToPng`/`captureElementToPng`) — never the raw
 * clipboard/dropped bytes, so the ≤2048px/≤4MB/EXIF-stripped guarantee (D5) holds from the moment
 * it lands in this state, not just at upload time. `annotations` accumulates as the operator boxes
 * or pins the image; `flattened` becomes true once "Done" in the annotator has baked them into
 * `dataUrl` (re-annotating after that re-opens the annotator against the flattened image itself —
 * v1 doesn't keep the pre-annotation original around for editing).
 */
export interface ImageAttachment {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  annotations: Annotation[];
  /** True once at least one "Done" pass has flattened annotations into `dataUrl`. */
  annotated: boolean;
}

/** Fold pasted-text chips into the outgoing message: fenced, appended after the typed text, in
 *  the order they were attached — this is the honest home for "attach" (04 removed the
 *  decorative button; nothing was ever wired to it). Runs before the parent's context-blob
 *  assembly in `handleSend`. */
export function assembleSendText(typedText: string, chips: PasteChip[]): string {
  if (chips.length === 0) return typedText;
  const fenced = chips.map((chip) => `\`\`\`\n${chip.content}\n\`\`\``).join('\n\n');
  return typedText ? `${typedText}\n\n${fenced}` : fenced;
}

/**
 * Body for `POST /api/friction` from the composer's grr popover (plans/daily-dogfood-engine/01) —
 * null when the gripe is empty after trim (nothing is sent). `repo`/`agentId` ride the active
 * session's agent when there is one; a defensively-agent-less composer still captures with
 * `repo: ''` rather than refusing (an annoyed operator must never be told "can't log that here").
 */
export function frictionCaptureBody(
  gripe: string,
  agent?: Pick<AgentDTO, 'id' | 'repo'>,
): { repo: string; gripe: string; context: string; agentId?: string } | null {
  const trimmed = gripe.trim();
  if (!trimmed) return null;
  return { repo: agent?.repo ?? '', gripe: trimmed, context: 'webapp-composer', ...(agent ? { agentId: agent.id } : {}) };
}

/** Fold one finalized speech segment into the draft — space-joined onto whatever's already there.
 *  Voice input always appends at the end and never auto-sends; the operator reviews the assembled
 *  draft (typed + dictated, in whatever order they arrived) before it goes anywhere. */
export function appendVoiceTranscript(current: string, segment: string): string {
  if (!segment) return current;
  if (!current) return segment;
  return /\s$/.test(current) ? `${current}${segment}` : `${current} ${segment}`;
}

/** A single paste-as-chip attachment: label + preview (hover `title`, click-to-expand) + remove,
 *  plus an "insert inline" escape hatch once expanded. Extracted as its own component so the
 *  markup is directly unit-testable (bun:test has no jsdom to drive the click interaction). */
export const ComposerAttachmentChip = ({
  chip,
  expanded,
  onToggle,
  onRemove,
  onInsertInline,
}: {
  chip: PasteChip;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onInsertInline: () => void;
}) => (
  <div className="flex flex-col items-start">
    <div className="flex items-center gap-1 rounded-lg border border-ink-border bg-white pl-2 pr-1 py-1 border-ink-border-2 bg-ink">
      <button
        type="button"
        onClick={onToggle}
        title={chip.content.slice(0, 400)}
        className="flex items-center gap-1.5 text-caption font-medium text-ink-text-label hover:text-ink-text text-ink-text-label dark:hover:text-ink-text"
      >
        <Paperclip className="h-3 w-3" aria-hidden />
        {chip.label}
      </button>
      <button
        type="button"
        aria-label={`Remove ${chip.label}`}
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-ink-text-subtle hover:bg-ink-surface hover:text-ink-text-label dark:hover:bg-ink-surface dark:hover:text-ink-text-label"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
    {expanded && (
      <div className="mt-1 max-h-40 w-full max-w-xs overflow-y-auto rounded-lg border border-ink-border bg-ink p-2 text-caption font-mono whitespace-pre-wrap text-ink-text-label border-ink-border bg-panel text-ink-text-label">
        {chip.content}
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={onInsertInline}
            className="text-caption font-medium text-amber-600 hover:underline dark:text-amber-400"
          >
            Insert inline
          </button>
        </div>
      </div>
    )}
  </div>
);

/** One attached image's thumbnail — remove + annotate affordances, and a small ember-accented dot
 *  once it carries at least one annotation (so "did I already mark this up?" is answerable at a
 *  glance, not by reopening the annotator). Extracted for the same static-markup-testability reason
 *  as `ComposerAttachmentChip`. */
export const ComposerImageThumb = ({
  image,
  status,
  onAnnotate,
  onRemove,
}: {
  image: ImageAttachment;
  status?: 'uploading' | 'failed';
  onAnnotate: () => void;
  onRemove: () => void;
}) => (
  <div className="group relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-ink-border">
    <img src={image.dataUrl} alt="Image ready to send" className="h-full w-full object-cover" />
    {image.annotations.length > 0 && (
      <span className="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden title={`${image.annotations.length} annotation${image.annotations.length === 1 ? '' : 's'}`} />
    )}
    {status && (
      <div className={`absolute inset-0 flex items-center justify-center p-1 text-center text-[10px] font-medium leading-tight ${status === 'failed' ? 'bg-red-950/80 text-red-100' : 'bg-black/65 text-white'}`} role={status === 'failed' ? 'alert' : 'status'}>
        {status === 'failed' ? 'Upload failed. Send again to retry.' : 'Uploading…'}
      </div>
    )}
    <div className="absolute inset-0 flex items-start justify-end gap-0.5 bg-black/0 p-0.5 opacity-0 transition-opacity group-hover:bg-black/20 group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        aria-label="Annotate image"
        onClick={onAnnotate}
        disabled={status === 'uploading'}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-ink-text-label hover:bg-panel/90 text-ink-text-body disabled:opacity-50"
      >
        <Pencil className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Remove image"
        onClick={onRemove}
        disabled={status === 'uploading'}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-ink-text-label hover:bg-panel/90 text-ink-text-body disabled:opacity-50"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  </div>
);

/**
 * Composer's send/stop toggle. When the active session's agent is running, this becomes a
 * "stop" affordance that fires `interrupt` (not `kill`) — see `agent-control.ts`. One press
 * debounces into a disabled "stopping…" state; it never escalates on a second press, and it
 * resets itself once the agent leaves the running state (or after a timeout if the driver
 * never reports back).
 */
export const ComposerSendButton = ({
  isStopShown,
  stopPending,
  canSend,
  onSend,
  onStop,
}: {
  isStopShown: boolean;
  stopPending: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
}) => {
  if (isStopShown) {
    return (
      <button
        type="button"
        aria-label={stopPending ? 'Stopping…' : 'Stop'}
        onClick={onStop}
        disabled={stopPending}
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
          stopPending
            ? 'bg-ink-border text-ink-text-subtle bg-ink-surface text-ink-text0'
            : 'bg-panel text-white hover:bg-black bg-ink-border text-ink-text dark:hover:bg-white'
        }`}
      >
        {stopPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Square className="h-3.5 w-3.5" aria-hidden />}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label="Send message"
      onClick={onSend}
      disabled={!canSend}
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
        canSend
          ? 'bg-panel text-white hover:bg-black bg-ink-border text-ink-text dark:hover:bg-white'
          : 'bg-ink-border text-ink-text-subtle bg-ink-surface text-ink-text0'
      }`}
    >
      <ArrowUp className="h-4 w-4" aria-hidden />
    </button>
  );
};

/**
 * The room's own live call (concern 05/09/10/11's OMP-live lane), as an icon-only trio in the
 * composer's icon row — post-ship fix: fleet navbar + composer call controls relocated this OUT
 * of the standing "Call" banner `VoiceCallHudView` used to render above every timeline (retention
 * notice, idle-policy line, the S2S-outside-rooms note, and a full-width "Start a call"/"Start
 * another call" pill, permanently on screen whether or not anyone cared). This is a RELOCATION —
 * `onStart`/`onEnd`/`onToggleMute` are `useRoomCall`'s own handlers, threaded through unchanged;
 * no new call logic lives here. The honest phase/retention state that banner used to spell out is
 * still reachable — in the call's own pane (VoiceCallHudView's info rows moved nowhere; the
 * component itself is simply no longer mounted as chrome) and in this control's own `title`.
 *
 * Idle → a single phone icon (`Start a call`/`Start another call`, told apart only in
 * `aria-label`/`title` now that there's no visible text label). Connecting/live/degraded → the
 * SAME slot swaps to icon-only mute + end, exactly mirroring `VoiceCallHudView`'s own `active`
 * rule (a call already bound to this thread renders its controls in full regardless of
 * `canStart` — hiding a live call would be the worse lie; `canStart` only withholds the
 * INVITATION to start one, e.g. on a unit's own conversation, which has its own vocabulary).
 */
export interface RoomCallComposerState {
  binding: VoiceCallBindingDTO | null;
  loading: boolean;
  starting: boolean;
  ending: boolean;
  muted: boolean;
  muteBusy: boolean;
  controlsAvailable: boolean;
  canStart: boolean;
  /** Set when the last start attempt failed. `VoiceCallHudView` showed this in place, deliberately
   *  "never as a toast that vanishes" (its own doc) — an icon has no room for standing text, so the
   *  honest failure reaches the title instead, which is still there for as long as it needs to be. */
  error?: string;
  onStart: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
}

export const RoomCallIconControls = ({
  binding,
  loading,
  starting,
  ending,
  muted,
  muteBusy,
  controlsAvailable,
  canStart,
  error,
  onStart,
  onEnd,
  onToggleMute,
}: RoomCallComposerState) => {
  const active = binding !== null && binding.state !== 'ended';
  if (active) {
    return (
      <>
        <button
          type="button"
          aria-label={muted ? 'Unmute the microphone' : 'Mute the microphone'}
          title={
            controlsAvailable
              ? muted
                ? 'Unmute. The room asked the session to mute; the protocol gives no read-back, so this is what was asked for, not a confirmed mic state.'
                : 'Mute. The room asks the session to mute — there is no read-back, so this records what was asked.'
              : 'There is no live socket to the session right now, so the mic cannot be changed.'
          }
          disabled={!controlsAvailable || muteBusy}
          onClick={onToggleMute}
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
            muted ? 'bg-red-100 text-red-500 dark:bg-red-900/30' : 'text-ink-text0 hover:bg-ink-surface text-ink-text-subtle dark:hover:bg-ink-surface'
          }`}
        >
          {muteBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
        </button>
        <button
          type="button"
          aria-label="End the call"
          title="End the call. The record stays in this thread."
          disabled={ending}
          onClick={onEnd}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-red-500 hover:bg-ink-surface disabled:opacity-40 dark:hover:bg-ink-surface"
        >
          {ending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PhoneOff className="h-4 w-4" aria-hidden />}
        </button>
      </>
    );
  }
  // Not active: an invitation to start, unless this surface withholds it (canStart=false — a
  // unit's own conversation) or the room genuinely doesn't know yet whether a call already exists
  // (`checking` — offering Start here would race the daemon's own single-active-call guard the
  // instant the real binding arrives a beat later; see VoiceCallHudView's own doc for this rule).
  if (!canStart || callPhase(binding, loading) === 'checking') return null;
  const baseTitle = 'Start a live call. The mic stays open; the conversation, decisions and artifacts all land in this thread.';
  return (
    <button
      type="button"
      aria-label={error ? 'Start a call — the last attempt failed' : binding ? 'Start another call in this thread' : 'Start a call in this thread'}
      title={error ? `${baseTitle} The last attempt failed: ${error}` : baseTitle}
      disabled={starting}
      onClick={onStart}
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
        error ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20' : 'text-ink-text0 hover:bg-ink-surface text-ink-text-subtle dark:hover:bg-ink-surface'
      }`}
    >
      {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PhoneCall className="h-4 w-4" aria-hidden />}
    </button>
  );
};

export const Composer = ({
  tasks,
  suggestionChips,
  sessionId,
  isLoading,
  isStopShown,
  stopPending,
  onStop,
  onSend,
  selectedModel,
  modelOptions,
  onModelChange,
  agent,
  agents = [],
  placeholder,
  focusKey,
  voiceCallEnabled = false,
  voiceCallActive = false,
  onStartVoiceCall,
  roomCall,
  onToast,
  onInputActivity,
}: {
  tasks: Task[];
  suggestionChips: SuggestionChip[];
  /** The thread this composer is writing into (daily-composer concern 01). Drives BOTH per-thread
   *  draft persistence (input/history/chips/images survive a tab kill via `draftStore`) and
   *  per-thread in-memory scoping: when this prop changes, the composer flushes the outgoing
   *  thread's draft and loads the incoming one's — the old unkeyed mount silently leaked the
   *  draft across threads. Absent (defensive) = ephemeral composer, nothing persisted. */
  sessionId?: string;
  isLoading: boolean;
  isStopShown: boolean;
  stopPending: boolean;
  onStop: () => void;
  onSend: (text: string) => void;
  onInputActivity?: (text: string) => void;
  selectedModel: string;
  modelOptions: ModelOption[];
  onModelChange: (model: string) => void;
  agent?: AgentDTO;
  agents?: AgentDTO[];
  /** Override the textarea's placeholder — e.g. a blocked agent's pending-request placeholder, so
   *  the composer visibly becomes the answer box for it (Fleet view §6b's "Composer prefilled for
   *  free text": the request's own context primes the field's label rather than literal guessed
   *  text — putting words in the operator's mouth for an open question would be presumptuous). */
  placeholder?: string;
  /** Changing this value refocuses the composer — used to snap focus onto the box the instant a
   *  new pending request appears, without stomping whatever the operator is mid-typing. */
  focusKey?: string | number;
  /** webapp-voice-lane concern 08: `GET /api/voice/config`'s `{enabled}`, read by `AssistantChat`
   *  via `useVoiceCall()` — `VoiceCallButton` itself renders nothing when this is false. */
  voiceCallEnabled?: boolean;
  /** A voice call (for any session) is already live — disables (doesn't hide) the button. */
  voiceCallActive?: boolean;
  /** Pins a new call to THIS composer's active session at click time. Absent when there's no
   *  active session to pin to (`AssistantChat`'s session-list screen never renders a `Composer`
   *  at all, so this is only ever absent defensively). */
  onStartVoiceCall?: () => void;
  /** The room's own live call (post-ship fix: fleet navbar + composer call controls) — absent
   *  entirely outside a room (e.g. any future non-room mount of this composer), present with
   *  `canStart: false` on a unit's own conversation. See `RoomCallIconControls`'s own doc. */
  roomCall?: RoomCallComposerState;
  /** Toast sink for the grr popover's confirmation/failure (both mounts pass their
   *  `useTaskContext().showToast` — a prop rather than a context read so this component stays
   *  importable in the jsdom-less bun test suite, same pattern as `AgentLandControls`). */
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}) => {
  // Draft persistence (daily-composer concern 01): the four sacred pieces of composer state —
  // input, prompt-recall history, paste-chips, image attachments — seed from this thread's
  // persisted draft on mount and are written back below (debounced on change, flushed on
  // beforeunload/hidden/unmount/send/thread-switch). `loadDraft` never throws: storage blocked or
  // corrupt just means an empty composer, same as before persistence existed.
  const [initialDraft] = useState<DraftV1 | null>(() => (sessionId ? loadDraft(sessionId) : null));
  const [input, setInput] = useState(initialDraft?.input ?? '');
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusKey === undefined) return;
    composerTextareaRef.current?.focus();
  }, [focusKey]);

  // History recall (ArrowUp/ArrowDown) cycles this thread's own prior sends — scoped per
  // `sessionId` (persisted in the draft store), so recall history follows the thread across
  // remounts and reloads instead of dying with the mount.
  const [promptHistory, setPromptHistory] = useState<string[]>(initialDraft?.promptHistory ?? []);
  const [recallState, setRecallState] = useState<HistoryRecallState>(INITIAL_RECALL_STATE);

  // Paste-as-chip: a large paste is diverted into an attachment chip instead of flooding the
  // textarea; chip contents are folded back into the outgoing text on send (see `submit`).
  const [chips, setChips] = useState<PasteChip[]>(initialDraft?.chips ?? []);
  const [expandedChipId, setExpandedChipId] = useState<string | null>(null);

  // Images into the conversation (Feature 2 D2): paste/drop/capture attach a downscaled PNG here;
  // `annotatingId` opens the ImageAnnotator modal for that one attachment. `isSending` is separate
  // from the parent's `isLoading` (which reflects the AGENT's running state) — it covers the
  // window where `submit` is awaiting the per-image upload round trip, before `onSend` even fires.
  const [images, setImages] = useState<ImageAttachment[]>(initialDraft?.images ?? []);
  const [annotatingId, setAnnotatingId] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<string[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Targets the person has actually picked from the menu. Only these expand — an unknown "@word" is
  // left exactly as typed, because guessing who someone meant is worse than sending what they wrote.
  const [mentioned, setMentioned] = useState<MentionTarget[]>([]);
  // Effort is remembered rather than reset each visit: a control that silently returns to a default is
  // one that quietly changes what runs without anybody having chosen it.
  // Read LAZILY, on first use rather than at mount. A defensive mount with no sessionId must touch no
  // storage at all — reading here made every such mount hit localStorage, which is the behaviour that
  // test exists to forbid, and it would have run on the server render too.
  const [effort, setEffortState] = useState<Effort>('high');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('glance:effort') as Effort | null;
      if (stored) setEffortState(stored);
    } catch { /* storage blocked — the default stands for this session */ }
  }, []);
  const setEffort = (next: Effort) => {
    setEffortState(next);
    try { window.localStorage.setItem('glance:effort', next); } catch { /* storage blocked; the choice still applies to this session */ }
  };

  // ---------------------------------------------------------------------------
  // Draft persistence wiring (daily-composer concern 01).
  //
  // `boundSessionIdRef` is the thread the CURRENT in-memory state belongs to — it lags the
  // `sessionId` prop by exactly the one render where a thread switch is being processed, which is
  // what lets the switch effect below flush thread A's draft under A's id before seeding thread
  // B's state. `draftSnapshotRef` always mirrors the latest state (reassigned every render, plus
  // synchronously at the two points where state and ref must not diverge even for a tick: the
  // switch itself and clear-on-send), so flush paths never read a stale closure.
  // ---------------------------------------------------------------------------
  const boundSessionIdRef = useRef<string | undefined>(sessionId);
  const draftSnapshotRef = useRef<{ sessionId: string | undefined; input: string; promptHistory: string[]; chips: PasteChip[]; images: ImageAttachment[] }>({
    sessionId,
    input,
    promptHistory,
    chips,
    images,
  });
  draftSnapshotRef.current = { sessionId: boundSessionIdRef.current, input, promptHistory, chips, images };

  // Reference-equality dirty check: state arrays/strings only change identity on a real change,
  // so an unchanged draft costs zero writes on visibilitychange spam (tab-hide fires constantly;
  // re-serializing multi-MB image data URLs each time would jank for nothing).
  const lastFlushedDraftRef = useRef<typeof draftSnapshotRef.current | null>(null);
  const flushDraftNow = () => {
    const snapshot = draftSnapshotRef.current;
    if (!snapshot.sessionId) return;
    const last = lastFlushedDraftRef.current;
    if (
      last &&
      last.sessionId === snapshot.sessionId &&
      last.input === snapshot.input &&
      last.promptHistory === snapshot.promptHistory &&
      last.chips === snapshot.chips &&
      last.images === snapshot.images
    ) {
      return;
    }
    lastFlushedDraftRef.current = snapshot;
    persistDraft({
      version: 1,
      sessionId: snapshot.sessionId,
      input: snapshot.input,
      promptHistory: snapshot.promptHistory,
      chips: snapshot.chips,
      images: snapshot.images,
      updatedAt: Date.now(),
    });
  };
  const flushDraftRef = useRef(flushDraftNow);
  flushDraftRef.current = flushDraftNow;

  // Thread switch WITHOUT remount (the old unkeyed-mount leak): flush the outgoing thread's
  // draft, then seed every draft-scoped piece of state from the incoming thread's persisted
  // entry. Doing this in the component (rather than relying on the parent to `key` the mount)
  // keeps focus/caret alive across switches and makes the no-leak guarantee self-contained.
  useEffect(() => {
    if (boundSessionIdRef.current === sessionId) return; // initial mount, or not a thread switch
    flushDraftRef.current();
    const next = sessionId ? loadDraft(sessionId) : null;
    boundSessionIdRef.current = sessionId;
    // One `seeded` object shared between the ref rebase, the clean-marker, and the setState calls —
    // the dirty check above compares by identity, so the state and the "last flushed" record must
    // hold the SAME array instances or the first tab-hide after a switch does a pointless rewrite.
    const seeded = {
      sessionId,
      input: next?.input ?? '',
      promptHistory: next?.promptHistory ?? [],
      chips: next?.chips ?? [],
      images: next?.images ?? [],
    };
    draftSnapshotRef.current = seeded;
    // The freshly-loaded draft IS the store's copy — mark it clean so an immediate tab-hide
    // doesn't rewrite it.
    lastFlushedDraftRef.current = seeded;
    setInput(seeded.input);
    setPromptHistory(seeded.promptHistory);
    setChips(seeded.chips);
    setImages(seeded.images);
    setRecallState(INITIAL_RECALL_STATE);
    setExpandedChipId(null);
    setAnnotatingId(null);
    setAttachError(null);
  }, [sessionId]);

  // Debounced persist on every draft-relevant change (300ms, t3code's number). The effect
  // cleanup IS the debounce: each change cancels the previous timer. Skipped on the very first
  // run so merely mounting doesn't re-write an unchanged draft.
  const draftPersistArmedRef = useRef(false);
  useEffect(() => {
    if (!draftPersistArmedRef.current) {
      draftPersistArmedRef.current = true;
      return;
    }
    if (!boundSessionIdRef.current) return;
    const timer = setTimeout(() => flushDraftRef.current(), DRAFT_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, promptHistory, chips, images]);

  // Unconditional flush on tab close/crash-adjacent signals and on unmount — this is what beats
  // the debounce window when the tab is killed 100ms after the last keystroke. `beforeunload`
  // covers close/refresh; `visibilitychange`→hidden covers backgrounding (and is the only signal
  // some mobile browsers fire before killing a tab); the cleanup flush covers the panel
  // unmounting with the draft still unsaved.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = () => flushDraftRef.current();
    const onVisibilityChange = () => {
      if (document.hidden) flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flush();
    };
  }, []);

  // Voice input (chained STT): browser Web Speech API transcribes into `input` — reviewed then
  // sent like any typed draft, never auto-sent. `speechSupported` gates the button itself rather
  // than being re-checked on click, so an unsupported browser sees a disabled button with an
  // honest tooltip instead of a click that silently does nothing (the exact defect that got the
  // previous mic button removed as a "misleading no-op").
  const speechSupported = isSpeechRecognitionSupported();
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Latched once the browser reports 'not-allowed' — a denied mic permission doesn't clear itself
  // mid-session, so re-clicking the button would just re-fail with the same error forever. Disabling
  // it for the rest of this mount is the honest state instead of an infinite click-fail loop.
  const [voiceDenied, setVoiceDenied] = useState(false);
  const voiceSessionRef = useRef<VoiceInputSession | null>(null);

  useEffect(() => () => { voiceSessionRef.current?.abort(); }, []); // stop listening on unmount

  const toggleVoiceInput = () => {
    if (isListening) {
      voiceSessionRef.current?.abort();
      return;
    }
    setVoiceError(null);
    const session = startVoiceInput({
      continuous: true, // chained: keep listening across multiple sentences until toggled off
      onListeningChange: setIsListening,
      onTranscript: (text) => setInput((prev) => appendVoiceTranscript(prev, text)),
      onError: (info) => {
        setVoiceError(info.message);
        if (info.code === 'not-allowed') setVoiceDenied(true);
      },
    });
    if (!session) {
      // Support can vanish between render and click (isSpeechRecognitionSupported() gates the
      // button, but a race — or a skipped check — must never look like a silent no-op).
      setVoiceError("Voice input isn't available right now — try again or type instead.");
      return;
    }
    voiceSessionRef.current = session;
  };

  const addImageFromSource = async (source: Blob | string) => {
    try {
      const downscaled = await downscaleToPng(source);
      setImages((prev) => [...prev, { id: nextImageAttachmentId(), ...downscaled, annotations: [], annotated: false }]);
    } catch {
      setAttachError('Could not read that image, so it was not attached. Try a different image file.');
    }
  };

  const addImageFiles = (files: Iterable<File>) => {
    const rejected = Array.from(files).map((file) => ({ file, error: imageAttachmentError(file) }));
    const firstError = rejected.find(({ error }) => error)?.error;
    if (firstError) setAttachError(firstError);
    for (const { file, error } of rejected) {
      if (!error) void addImageFromSource(file);
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
    setFailedImageIds((prev) => prev.filter((failedId) => failedId !== id));
    setAnnotatingId((prev) => (prev === id ? null : prev));
  };

  const handleAnnotateDone = (id: string, flattenedDataUrl: string, annotations: Annotation[]) => {
    setImages((prev) => prev.map((img) => (img.id === id ? { ...img, dataUrl: flattenedDataUrl, annotations, annotated: annotations.length > 0 } : img)));
    setAnnotatingId(null);
  };

  const handleCaptureView = async () => {
    const el = document.getElementById('omp-main-content');
    if (!el) {
      setAttachError('Nothing to capture — no page content found.');
      return;
    }
    setIsCapturing(true);
    try {
      const captured = await captureElementToPng(el);
      setImages((prev) => [...prev, { id: nextImageAttachmentId(), ...captured, annotations: [], annotated: false }]);
      setAttachError(null);
    } catch {
      setAttachError('Could not capture the current view — try a screenshot + paste instead.');
    } finally {
      setIsCapturing(false);
    }
  };

  // `@`-mention combobox — caret-anchored via the composer textarea's real selection, not a
  // split(' ') heuristic. Task filtering stays synchronous over `tasks`; the `triggers` array
  // is extensible so a future `/` command menu slots in beside it.
  const mentionTriggers = useMemo<TriggerSource<MentionTarget>[]>(() => [
    {
      trigger: '@',
      search: (query) => flattenMentionSections(buildMentionSections(agents, tasks, query)),
      getId: (item) => `${item.kind}:${item.id}`,
      getLabel: mentionLabel,
      getReplacement: (target: MentionTarget) => {
        // The readable token goes in the box; the address is restored at send.
        setMentioned((prev) => (prev.some((t) => t.kind === target.kind && t.id === target.id) ? prev : [...prev, target]));
        return mentionToken(target);
      },
    },
  ], [agents, tasks]);
  const mentionMenu = useTriggerMenu(composerTextareaRef, mentionTriggers, setInput);

  // Auto-grow: track content height up to the 8-line cap, then scroll. Runs on every `input`
  // change (typed, pasted, recalled, or cleared on send) rather than only on the raw `onChange`
  // DOM event, since a controlled textarea's value can also change without one (e.g. the
  // programmatic clear-on-send below).
  useEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${clampGrownHeight(el.scrollHeight)}px`;
  }, [input]);

  // Select-all on recall (terminal convention) — only while actively browsing history; the
  // effect runs after the DOM value commits, so `.select()` selects the recalled text, not the
  // stale pre-update value.
  useEffect(() => {
    if (recallState.index === -1) return;
    composerTextareaRef.current?.select();
  }, [recallState]);

  const submit = async () => {
    const typed = input.trim();
    if ((!typed && chips.length === 0 && images.length === 0) || isLoading || isSending) return;
    setIsSending(true);
    setFailedImageIds([]);
    setAttachError(null);
    setUploadProgress(images.length > 0 ? { completed: 0, total: images.length } : null);
    try {
      const uploadedPaths: string[] = [];
      for (const [index, image] of images.entries()) {
        try {
          const uploaded = await uploadChatAttachment(image.dataUrl);
          uploadedPaths.push(uploaded.path);
          setUploadProgress({ completed: index + 1, total: images.length });
        } catch (error) {
          setFailedImageIds([image.id]);
          const reason = error instanceof Error && error.message ? ` ${error.message}` : '';
          throw new Error(`Couldn't upload image ${index + 1} of ${images.length}.${reason} The preview is still attached; check the image or connection, then send again to retry.`);
        }
      }
      const imageRefs = joinImagePromptRefs(uploadedPaths);
      // Addresses restored here, at the last moment: everything the person saw and edited was the
      // readable token, and the wire format `resolveMentionRoute` parses is unchanged.
      const textToSend = [expandMentionTokens(assembleSendText(typed, chips), mentioned), imageRefs].filter(Boolean).join('\n\n');
      const nextHistory = typed ? pushPromptHistory(promptHistory, typed) : promptHistory;
      const clearedChips: PasteChip[] = [];
      const clearedImages: ImageAttachment[] = [];
      setInput('');
      setChips(clearedChips);
      setExpandedChipId(null);
      setImages(clearedImages);
      setPromptHistory(nextHistory);
      setRecallState(INITIAL_RECALL_STATE);
      draftSnapshotRef.current = { sessionId: boundSessionIdRef.current, input: '', promptHistory: nextHistory, chips: clearedChips, images: clearedImages };
      flushDraftRef.current();
      onSend(textToSend);
    } catch (error) {
      setAttachError(error instanceof Error && error.message ? error.message : 'Could not upload the image. The preview is still attached; check your connection and send again to retry.');
    } finally {
      setIsSending(false);
      setUploadProgress(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return; // IME composition in progress — never submit/recall/nav on this keystroke
    if (mentionMenu.handleKeyDown(e)) return; // menu consumed the key (nav/select/dismiss)
    const el = e.currentTarget;
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
      const recalled = recallOlder(recallState, promptHistory, input);
      if (recalled) {
        e.preventDefault();
        setRecallState(recalled.state);
        setInput(recalled.value);
      }
      return;
    }
    if (e.key === 'ArrowDown' && el.selectionStart === input.length && el.selectionEnd === input.length) {
      const recalled = recallNewer(recallState, promptHistory);
      if (recalled) {
        e.preventDefault();
        setRecallState(recalled.state);
        setInput(recalled.value);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Image paste (Feature 2 D2) — checked FIRST: a screenshot copied to the clipboard often also
    // carries an (empty or placeholder) text item, and the image is always the intent when present.
    const items = e.clipboardData?.items;
    const imageFiles: File[] = [];
    if (items) {
      for (const item of items) {
        if (isRasterImageType(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImageFiles(imageFiles);
      return;
    }
    const text = e.clipboardData?.getData('text') ?? '';
    if (!shouldChipPaste(text)) return; // short paste — let it land in the textarea as usual
    e.preventDefault();
    setChips((prev) => [...prev, { id: `chip:${Date.now()}:${Math.random().toString(36).slice(2)}`, label: pasteChipLabel(text), content: text }]);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return; // still inside the drop zone
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    setIsDragOver(false);
    addImageFiles(files);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addImageFiles(e.target.files);
    e.target.value = ''; // allow re-selecting the same file consecutively
  };

  const removeChip = (id: string) => {
    setChips((prev) => prev.filter((chip) => chip.id !== id));
    setExpandedChipId((prev) => (prev === id ? null : prev));
  };

  // Friction capture (plans/daily-dogfood-engine/01): a ghost toolbar button opens a one-input
  // popover; Enter POSTs immediately (one click + one Enter is the whole budget), Escape cancels
  // with no request. Draft state survives while the popover is open — logging a gripe must never
  // eat the message being composed.
  const [grrOpen, setGrrOpen] = useState(false);
  const [grrText, setGrrText] = useState('');
  const [grrBusy, setGrrBusy] = useState(false);
  const grrInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (grrOpen) grrInputRef.current?.focus();
  }, [grrOpen]);

  const closeGrr = () => {
    setGrrOpen(false);
    setGrrText('');
  };

  const submitGrr = async () => {
    const body = frictionCaptureBody(grrText, agent);
    if (!body || grrBusy) return;
    setGrrBusy(true);
    try {
      const res = await apiFetch('/api/friction', jsonInit('POST', body));
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      closeGrr();
      onToast?.('Logged to the friction ledger');
    } catch (err) {
      // The text stays in the input — a failed capture the operator has to retype is itself friction.
      onToast?.(err instanceof Error && err.message ? `Not logged: ${err.message}` : 'Not logged — is the daemon reachable?', 'error');
    } finally {
      setGrrBusy(false);
    }
  };

  const handleGrrKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitGrr();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeGrr();
    }
  };

  const insertChipInline = (id: string) => {
    const chip = chips.find((c) => c.id === id);
    if (!chip) return;
    setInput((prev) => (prev ? `${prev}\n${chip.content}` : chip.content));
    setChips((prev) => prev.filter((c) => c.id !== id));
    setExpandedChipId((prev) => (prev === id ? null : prev));
  };

  return (
    <div className="p-3 bg-panel flex-shrink-0 border-t border-ink-border">
      <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide" aria-label="Contextual suggestions">
        {suggestionChips.map((suggestion, index) => (
          <button
            key={suggestion.label}
            type="button"
            onClick={() => {
              // Insert, don't send — a chip click must never destroy an
              // in-progress draft or silently submit on the user's behalf.
              setInput((prev) => applySuggestionChip(prev, suggestion.prompt));
              composerTextareaRef.current?.focus();
            }}
            className="flex min-h-8 items-center gap-1.5 rounded-full border border-ink-border bg-ink-surface px-2.5 py-1 text-caption font-medium text-ink-text-label transition-colors whitespace-nowrap hover:bg-ink-border focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 border-ink-border bg-panel text-ink-text-label dark:hover:bg-ink-surface dark:focus-visible:ring-offset-gray-950"
          >
            {index === 0 && <Sparkles className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" aria-hidden />}
            {suggestion.label}
          </button>
        ))}
      </div>

      <div
        // NO box. The composer sits inside the room's own footer band, which already has a top rule —
        // drawing another border here put a rectangle inside a rectangle, and the inner one was doing
        // no work except making the input look like a widget dropped into the page. The drag state is
        // the one case that needs an edge, so it is the only case that draws one.
        style={{ background: 'transparent', borderColor: isDragOver ? '#D9A03C' : 'transparent', borderRadius: 3 }}
        className={`relative flex flex-col border transition-colors ${isDragOver ? 'ring-2 ring-amber-500/20' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-xl bg-amber-50/90 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            Drop image to attach
          </div>
        )}

        {mentionMenu.isOpen && (
          <div
            id={mentionMenu.listboxId}
            role="listbox"
            aria-label="Mention an agent or issue"
            className="absolute bottom-full left-0 mb-2 w-full max-h-48 overflow-y-auto bg-panel border border-ink-border rounded-xl shadow-lg z-50"
          >
            <div className="p-2 text-xs font-medium text-ink-text0 border-b border-ink-border">
              Mention an agent or issue
            </div>
            {/* `mentionMenu.isOpen` is only true when there's at least one match — a
                zero-match session renders nothing (see useTriggerMenu's `visiblyOpen`)
                rather than showing a "No matching tasks" popup that hijacks the keyboard. */}
            {buildMentionSections(agents, tasks, mentionMenu.query).map((section) => section.items.length > 0 && (
              <div key={section.id} data-mention-section={section.id}>
                <div className="px-3 py-1.5 text-caption font-semibold uppercase tracking-wide text-ink-text-subtle">{section.label}</div>
                {section.items.map((item) => {
                  const index = mentionMenu.items.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id);
                  return (
                    <button
                      key={`${item.kind}:${item.id}`}
                      type="button"
                      {...mentionMenu.getOptionProps(index)}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${index === mentionMenu.activeIndex ? 'bg-ink-surface text-ink-text' : 'text-ink-text-label hover:bg-ink-surface'}`}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.kind === 'agent' ? (item.status === 'working' ? '#f59e0b' : item.status === 'input' || item.status === 'idle' ? '#10b981' : '#64748b') : '#3b82f6' }}></span>
                      <span className="truncate">{mentionLabel(item)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2" aria-label="Pasted attachments">
            {chips.map((chip) => (
              <ComposerAttachmentChip
                key={chip.id}
                chip={chip}
                expanded={expandedChipId === chip.id}
                onToggle={() => setExpandedChipId((prev) => (prev === chip.id ? null : chip.id))}
                onRemove={() => removeChip(chip.id)}
                onInsertInline={() => insertChipInline(chip.id)}
              />
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2" aria-label="Attached images">
            {images.map((image) => (
              <ComposerImageThumb
                key={image.id}
                image={image}
                status={isSending ? 'uploading' : failedImageIds.includes(image.id) ? 'failed' : undefined}
                onAnnotate={() => setAnnotatingId(image.id)}
                onRemove={() => removeImage(image.id)}
              />
            ))}
          </div>
        )}
        {uploadProgress && (
          <div className="px-2.5 pt-2 text-caption text-ink-text-muted" role="status">
            Uploading image {uploadProgress.completed + 1} of {uploadProgress.total}. The message will send when every preview is stored.
          </div>
        )}
        {attachError && (
          <div className="px-2.5 pt-2 text-caption text-red-600 dark:text-red-400" role="alert">
            {attachError}
          </div>
        )}

        {voiceError && (
          <div className="px-2.5 pt-2 text-caption text-red-600 dark:text-red-400" role="alert">
            {voiceError}
          </div>
        )}

        <div className="relative">
        {/* Mentions drawn as chips over the real characters. The text underneath is unchanged, so the
            wire format `resolveMentionRoute` parses stays exactly as it was. */}
        <MentionOverlay text={input} />
        <textarea
          ref={composerTextareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            onInputActivity?.(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder ?? 'Type @ to link a task...'}
          className="relative w-full resize-none overflow-y-auto border-none bg-transparent px-3 py-2.5 text-[13px] leading-6 outline-none"
          // Transparent text, visible caret: the overlay draws what a person reads, the textarea keeps
          // what gets sent. Selection stays visible via ::selection on the real input.
          style={{ color: 'transparent', caretColor: '#F0A35A' }}
          disabled={isLoading || isSending}
          rows={1}
          {...mentionMenu.comboboxProps}
        />
        </div>
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="flex min-w-0 items-center gap-1">
            <ModelPicker
              options={modelOptions}
              value={selectedModel}
              onChange={onModelChange}
              effort={effort}
              onEffortChange={setEffort}
            />
            <ComposerStats agent={agent} />
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileInputChange} />
            <button
              type="button"
              aria-label="Attach image"
              title="Attach image"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-ink-text0 hover:bg-ink-surface text-ink-text-subtle dark:hover:bg-ink-surface"
            >
              <ImagePlus className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Capture view"
              title="Capture view"
              disabled={isCapturing}
              onClick={() => void handleCaptureView()}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-ink-text0 hover:bg-ink-surface disabled:opacity-40 text-ink-text-subtle dark:hover:bg-ink-surface"
            >
              {isCapturing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              aria-label="Voice input"
              title={
                voiceDenied
                  ? 'Microphone access was denied — allow it in your browser settings to use voice input'
                  : speechSupported
                    ? "Voice input — your browser may send audio to its speech-recognition service to transcribe it (Chrome does)"
                    : "Voice input isn't supported in this browser"
              }
              disabled={!speechSupported || voiceDenied}
              onClick={toggleVoiceInput}
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                isListening
                  ? 'bg-red-100 text-red-500 dark:bg-red-900/30'
                  : 'text-ink-text0 hover:bg-ink-surface text-ink-text-subtle dark:hover:bg-ink-surface'
              }`}
            >
              <Mic className="h-4 w-4" aria-hidden />
            </button>
            <VoiceCallButton enabled={voiceCallEnabled} active={voiceCallActive} onStart={() => onStartVoiceCall?.()} />
            {roomCall ? <RoomCallIconControls {...roomCall} /> : null}
            <div className="relative">
              <button
                type="button"
                aria-label="Log friction"
                title="Log friction — capture what just annoyed you (goes to the dogfood ledger, glance grr --list)"
                aria-expanded={grrOpen}
                onClick={() => (grrOpen ? closeGrr() : setGrrOpen(true))}
                className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
                  grrOpen ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400' : 'text-ink-text0 hover:bg-ink-surface text-ink-text-subtle dark:hover:bg-ink-surface'
                }`}
              >
                <Frown className="h-4 w-4" aria-hidden />
              </button>
              {grrOpen && (
                <div className="absolute bottom-10 left-0 z-50 w-72 rounded-xl border border-ink-border bg-white p-2 shadow-lg border-ink-border bg-panel" role="dialog" aria-label="Log friction">
                  <input
                    ref={grrInputRef}
                    value={grrText}
                    onChange={(e) => setGrrText(e.target.value)}
                    onKeyDown={handleGrrKeyDown}
                    placeholder="What just annoyed you?"
                    disabled={grrBusy}
                    className="w-full rounded-lg bg-ink px-2 py-1.5 text-[13px] text-ink-text outline-none placeholder:text-ink-text-subtle bg-ink text-ink-text-body"
                  />
                  <div className="mt-1 flex items-center justify-between px-1 text-caption text-ink-text-subtle">
                    <span>{grrBusy ? 'Logging…' : 'Enter logs it · Esc cancels'}</span>
                    <Frown className="h-3 w-3 text-amber-500/70" aria-hidden />
                  </div>
                </div>
              )}
            </div>
          </div>
          <ComposerSendButton
            isStopShown={isStopShown}
            stopPending={stopPending}
            canSend={(!!input.trim() || chips.length > 0 || images.length > 0) && !isLoading && !isSending}
            onSend={() => void submit()}
            onStop={onStop}
          />
        </div>
      </div>

      {annotatingId && (() => {
        const image = images.find((img) => img.id === annotatingId);
        if (!image) return null;
        return (
          <ImageAnnotator
            image={image}
            initialAnnotations={image.annotations}
            onDone={(flattenedDataUrl, annotations) => handleAnnotateDone(image.id, flattenedDataUrl, annotations)}
            onCancel={() => setAnnotatingId(null)}
          />
        );
      })()}
    </div>
  );
};
