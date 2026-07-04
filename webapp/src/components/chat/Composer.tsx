import React, { useMemo, useRef, useState } from 'react';
import { Sparkles, ArrowUp, Square, Loader2 } from 'lucide-react';
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

  const submit = (forcedInput?: string) => {
    const textToSend = forcedInput || input.trim();
    if (!textToSend || isLoading) return;
    setInput('');
    onSend(textToSend);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMenu.handleKeyDown(e)) return; // menu consumed the key (nav/select/dismiss)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
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

        <textarea
          ref={composerTextareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type @ to link a task..."
          className="w-full bg-transparent border-none outline-none text-[13px] text-gray-900 dark:text-gray-200 px-3 py-2.5 resize-none min-h-12 max-h-40"
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
            canSend={!!input.trim() && !isLoading}
            onSend={() => submit()}
            onStop={onStop}
          />
        </div>
      </div>
    </div>
  );
};
