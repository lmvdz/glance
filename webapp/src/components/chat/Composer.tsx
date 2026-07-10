import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ImagePlus, Loader2, Mic, Paperclip, Pencil, Sparkles, ArrowUp, Square, X } from 'lucide-react';
import { isImeComposing, useTriggerMenu, type TriggerSource } from '../../hooks/chat/useTriggerMenu';
import { ComposerStats } from './AgentMetaBar';
import { ImageAnnotator, type Annotation } from './ImageAnnotator';
import {
  captureElementToPng,
  downscaleToPng,
  isRasterImageType,
  joinImagePromptRefs,
  nextImageAttachmentId,
  uploadChatAttachment,
} from '../../lib/imageAttachment';
import { isSpeechRecognitionSupported, startVoiceInput, type VoiceInputSession } from '../../lib/voice/speech';
import type { AgentDTO } from '../../lib/dto';
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
    <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white pl-2 pr-1 py-1 dark:border-gray-700 dark:bg-gray-950">
      <button
        type="button"
        onClick={onToggle}
        title={chip.content.slice(0, 400)}
        className="flex items-center gap-1.5 text-[11px] font-medium text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
      >
        <Paperclip className="h-3 w-3" aria-hidden />
        {chip.label}
      </button>
      <button
        type="button"
        aria-label={`Remove ${chip.label}`}
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-300"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
    {expanded && (
      <div className="mt-1 max-h-40 w-full max-w-xs overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2 text-[11px] font-mono whitespace-pre-wrap text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
        {chip.content}
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={onInsertInline}
            className="text-[11px] font-medium text-amber-600 hover:underline dark:text-amber-400"
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
  onAnnotate,
  onRemove,
}: {
  image: ImageAttachment;
  onAnnotate: () => void;
  onRemove: () => void;
}) => (
  <div className="group relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
    <img src={image.dataUrl} alt="Attached" className="h-full w-full object-cover" />
    {image.annotations.length > 0 && (
      <span className="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden title={`${image.annotations.length} annotation${image.annotations.length === 1 ? '' : 's'}`} />
    )}
    <div className="absolute inset-0 flex items-start justify-end gap-0.5 bg-black/0 p-0.5 opacity-0 transition-opacity group-hover:bg-black/20 group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        aria-label="Annotate image"
        onClick={onAnnotate}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-gray-700 hover:bg-white dark:bg-gray-900/90 dark:text-gray-200"
      >
        <Pencil className="h-3 w-3" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Remove image"
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-gray-700 hover:bg-white dark:bg-gray-900/90 dark:text-gray-200"
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
            ? 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
            : 'bg-gray-900 text-white hover:bg-black dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white'
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
          ? 'bg-gray-900 text-white hover:bg-black dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white'
          : 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
      }`}
    >
      <ArrowUp className="h-4 w-4" aria-hidden />
    </button>
  );
};

export const Composer = ({
  tasks,
  suggestionChips,
  isLoading,
  isStopShown,
  stopPending,
  onStop,
  onSend,
  selectedModel,
  modelOptions,
  onModelChange,
  agent,
  placeholder,
  focusKey,
}: {
  tasks: Task[];
  suggestionChips: SuggestionChip[];
  isLoading: boolean;
  isStopShown: boolean;
  stopPending: boolean;
  onStop: () => void;
  onSend: (text: string) => void;
  selectedModel: string;
  modelOptions: ModelOption[];
  onModelChange: (model: string) => void;
  agent?: AgentDTO;
  /** Override the textarea's placeholder — e.g. a blocked agent's pending-request placeholder, so
   *  the composer visibly becomes the answer box for it (Fleet view §6b's "Composer prefilled for
   *  free text": the request's own context primes the field's label rather than literal guessed
   *  text — putting words in the operator's mouth for an open question would be presumptuous). */
  placeholder?: string;
  /** Changing this value refocuses the composer — used to snap focus onto the box the instant a
   *  new pending request appears, without stomping whatever the operator is mid-typing. */
  focusKey?: string | number;
}) => {
  const [input, setInput] = useState('');
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusKey === undefined) return;
    composerTextareaRef.current?.focus();
  }, [focusKey]);

  // History recall (ArrowUp/ArrowDown) cycles this composer instance's own prior sends —
  // scoped to this mount rather than reaching into the parent's session store, since Composer
  // already owns every send that passes through `submit`. Not persisted across a full remount.
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [recallState, setRecallState] = useState<HistoryRecallState>(INITIAL_RECALL_STATE);

  // Paste-as-chip: a large paste is diverted into an attachment chip instead of flooding the
  // textarea; chip contents are folded back into the outgoing text on send (see `submit`).
  const [chips, setChips] = useState<PasteChip[]>([]);
  const [expandedChipId, setExpandedChipId] = useState<string | null>(null);

  // Images into the conversation (Feature 2 D2): paste/drop/capture attach a downscaled PNG here;
  // `annotatingId` opens the ImageAnnotator modal for that one attachment. `isSending` is separate
  // from the parent's `isLoading` (which reflects the AGENT's running state) — it covers the
  // window where `submit` is awaiting the per-image upload round trip, before `onSend` even fires.
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [annotatingId, setAnnotatingId] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Voice input (chained STT): browser Web Speech API transcribes into `input` — reviewed then
  // sent like any typed draft, never auto-sent. `speechSupported` gates the button itself rather
  // than being re-checked on click, so an unsupported browser sees a disabled button with an
  // honest tooltip instead of a click that silently does nothing (the exact defect that got the
  // previous mic button removed as a "misleading no-op").
  const speechSupported = isSpeechRecognitionSupported();
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
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
      onError: (info) => setVoiceError(info.message),
    });
    voiceSessionRef.current = session ?? null;
  };

  const addImageFromSource = async (source: Blob | string) => {
    try {
      const downscaled = await downscaleToPng(source);
      setImages((prev) => [...prev, { id: nextImageAttachmentId(), ...downscaled, annotations: [], annotated: false }]);
      setAttachError(null);
    } catch {
      setAttachError('Could not read that image — try a different file.');
    }
  };

  const addImageFiles = (files: Iterable<File>) => {
    for (const file of files) {
      if (isRasterImageType(file.type)) void addImageFromSource(file);
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
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
  const mentionTriggers = useMemo<TriggerSource<Task>[]>(() => [
    {
      trigger: '@',
      search: (query) => tasks.filter((t) => t.title.toLowerCase().includes(query.toLowerCase())),
      getId: (t) => t.id,
      getLabel: (t) => t.title,
    },
  ], [tasks]);
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
    try {
      // Upload every attached image BEFORE the turn goes out — the outgoing text needs each
      // one's server-assigned path to fence in (D2/D5's artifact-path transport decision;
      // imageAttachment.ts's header comment covers why there's no inline-image channel to use
      // instead). A failed upload aborts the whole send rather than silently dropping the image
      // or sending a broken reference — the draft (text/chips/images) is left intact so the
      // operator can just retry.
      const uploaded = await Promise.all(images.map((img) => uploadChatAttachment(img.dataUrl)));
      const imageRefs = joinImagePromptRefs(uploaded.map((u) => u.path));
      const textToSend = [assembleSendText(typed, chips), imageRefs].filter(Boolean).join('\n\n');
      setInput('');
      setChips([]);
      setExpandedChipId(null);
      setImages([]);
      setAttachError(null);
      if (typed) setPromptHistory((prev) => pushPromptHistory(prev, typed));
      setRecallState(INITIAL_RECALL_STATE);
      onSend(textToSend);
    } catch {
      setAttachError('Could not attach one or more images — check your connection and try sending again.');
    } finally {
      setIsSending(false);
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

  const insertChipInline = (id: string) => {
    const chip = chips.find((c) => c.id === id);
    if (!chip) return;
    setInput((prev) => (prev ? `${prev}\n${chip.content}` : chip.content));
    setChips((prev) => prev.filter((c) => c.id !== id));
    setExpandedChipId((prev) => (prev === id ? null : prev));
  };

  return (
    <div className="p-3 bg-white dark:bg-gray-950 flex-shrink-0 border-t border-gray-200 dark:border-gray-800">
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
            className="flex min-h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors whitespace-nowrap hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:focus-visible:ring-offset-gray-950"
          >
            {index === 0 && <Sparkles className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" aria-hidden />}
            {suggestion.label}
          </button>
        ))}
      </div>

      <div
        className={`relative bg-gray-50 dark:bg-gray-900 border rounded-xl flex flex-col transition-colors ${isDragOver ? 'border-amber-500 ring-2 ring-amber-500/30' : 'border-gray-200 dark:border-gray-800 focus-within:border-gray-400 dark:focus-within:border-gray-600'}`}
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
            aria-label="Mention a task"
            className="absolute bottom-full left-0 mb-2 w-full max-h-48 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-lg z-50"
          >
            <div className="p-2 text-xs font-medium text-gray-500 border-b border-gray-200 dark:border-gray-800">
              Mention a task
            </div>
            {/* `mentionMenu.isOpen` is only true when there's at least one match — a
                zero-match session renders nothing (see useTriggerMenu's `visiblyOpen`)
                rather than showing a "No matching tasks" popup that hijacks the keyboard. */}
            {mentionMenu.items.map((task, index) => (
              <button
                key={task.id}
                type="button"
                {...mentionMenu.getOptionProps(index)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${index === mentionMenu.activeIndex ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: task.status === 'done' ? '#10b981' : '#3b82f6' }}></span>
                {task.title}
              </button>
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
              <ComposerImageThumb key={image.id} image={image} onAnnotate={() => setAnnotatingId(image.id)} onRemove={() => removeImage(image.id)} />
            ))}
          </div>
        )}

        {attachError && (
          <div className="px-2.5 pt-2 text-[11px] text-red-600 dark:text-red-400" role="alert">
            {attachError}
          </div>
        )}

        {voiceError && (
          <div className="px-2.5 pt-2 text-[11px] text-red-600 dark:text-red-400" role="alert">
            {voiceError}
          </div>
        )}

        <textarea
          ref={composerTextareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder ?? 'Type @ to link a task...'}
          className="w-full bg-transparent border-none outline-none text-[13px] text-gray-900 dark:text-gray-200 px-3 py-2.5 resize-none overflow-y-auto"
          disabled={isLoading || isSending}
          rows={1}
          {...mentionMenu.comboboxProps}
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="flex min-w-0 items-center gap-1">
            <select
              value={selectedModel}
              onChange={(event) => onModelChange(event.target.value)}
              className="h-8 max-w-36 rounded-full border border-gray-200 bg-white px-2 text-[11px] font-medium text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300"
              aria-label="Model"
            >
              {modelOptions.map((option) => (
                <option key={option.value || 'default'} value={option.value}>{option.label}</option>
              ))}
            </select>
            <ComposerStats agent={agent} />
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileInputChange} />
            <button
              type="button"
              aria-label="Attach image"
              title="Attach image"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <ImagePlus className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Capture view"
              title="Capture view"
              disabled={isCapturing}
              onClick={() => void handleCaptureView()}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              {isCapturing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              aria-label="Voice input"
              title={
                speechSupported
                  ? "Voice input — your browser may send audio to its speech-recognition service to transcribe it (Chrome does)"
                  : "Voice input isn't supported in this browser"
              }
              disabled={!speechSupported}
              onClick={toggleVoiceInput}
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${
                isListening
                  ? 'bg-red-100 text-red-500 dark:bg-red-900/30'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              <Mic className="h-4 w-4" aria-hidden />
            </button>
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
