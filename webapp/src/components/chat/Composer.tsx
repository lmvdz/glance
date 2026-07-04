import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, ArrowUp, Square, Loader2, Paperclip, X } from 'lucide-react';
import { useTriggerMenu, type TriggerSource } from '../../hooks/chat/useTriggerMenu';
import { ComposerStats } from './AgentMetaBar';
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

export interface PasteChip {
  id: string;
  label: string;
  content: string;
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
}) => {
  const [input, setInput] = useState('');
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  // History recall (ArrowUp/ArrowDown) cycles this composer instance's own prior sends —
  // scoped to this mount rather than reaching into the parent's session store, since Composer
  // already owns every send that passes through `submit`. Not persisted across a full remount.
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [recallState, setRecallState] = useState<HistoryRecallState>(INITIAL_RECALL_STATE);

  // Paste-as-chip: a large paste is diverted into an attachment chip instead of flooding the
  // textarea; chip contents are folded back into the outgoing text on send (see `submit`).
  const [chips, setChips] = useState<PasteChip[]>([]);
  const [expandedChipId, setExpandedChipId] = useState<string | null>(null);

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

  const submit = (forcedInput?: string) => {
    const typed = forcedInput || input.trim();
    if ((!typed && chips.length === 0) || isLoading) return;
    const textToSend = assembleSendText(typed, chips);
    setInput('');
    setChips([]);
    setExpandedChipId(null);
    if (typed) setPromptHistory((prev) => pushPromptHistory(prev, typed));
    setRecallState(INITIAL_RECALL_STATE);
    onSend(textToSend);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      submit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!shouldChipPaste(text)) return; // short paste — let it land in the textarea as usual
    e.preventDefault();
    setChips((prev) => [...prev, { id: `chip:${Date.now()}:${Math.random().toString(36).slice(2)}`, label: pasteChipLabel(text), content: text }]);
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
            onClick={() => submit(suggestion.prompt)}
            className="flex min-h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors whitespace-nowrap hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:focus-visible:ring-offset-gray-950"
          >
            {index === 0 && <Sparkles className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" aria-hidden />}
            {suggestion.label}
          </button>
        ))}
      </div>

      <div className="relative bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl flex flex-col focus-within:border-gray-400 dark:focus-within:border-gray-600 transition-colors">

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
            {mentionMenu.items.length > 0 ? (
              mentionMenu.items.map((task, index) => (
                <button
                  key={task.id}
                  type="button"
                  {...mentionMenu.getOptionProps(index)}
                  className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${index === mentionMenu.activeIndex ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: task.status === 'done' ? '#10b981' : '#3b82f6' }}></span>
                  {task.title}
                </button>
              ))
            ) : (
              <div className="px-3 py-4 text-center text-sm text-gray-500">
                No matching tasks
              </div>
            )}
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

        <textarea
          ref={composerTextareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type @ to link a task..."
          className="w-full bg-transparent border-none outline-none text-[13px] text-gray-900 dark:text-gray-200 px-3 py-2.5 resize-none overflow-y-auto"
          disabled={isLoading}
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
          </div>
          <ComposerSendButton
            isStopShown={isStopShown}
            stopPending={stopPending}
            canSend={(!!input.trim() || chips.length > 0) && !isLoading}
            onSend={() => submit()}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
};
