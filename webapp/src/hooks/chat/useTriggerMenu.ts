import { useCallback, useMemo, useState } from 'react';
import type {
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SyntheticEvent as ReactSyntheticEvent,
} from 'react';

// =============================================================================
// Pure decision functions — unit-tested without a DOM (bun:test, no jsdom).
// =============================================================================

export interface DetectedTrigger {
  trigger: string;
  query: string;
  /** Index of the trigger character itself (not the query start). */
  start: number;
}

/**
 * Scan backward from `caret` for the nearest trigger character that opens a
 * mention/command session. A trigger is valid only when it is preceded by
 * start-of-text or whitespace (so `user@domain.com` never triggers on the
 * `@` inside a word). The query intentionally CAN contain spaces — task
 * titles are multi-word — so whitespace does not terminate the scan; only a
 * newline does (a query never spans lines) and finding the trigger char
 * itself does (the nearest one wins; we do not keep searching past an
 * invalid match for an earlier, valid one).
 */
export function detectTrigger(text: string, caret: number, triggerChars: readonly string[]): DetectedTrigger | null {
  const end = Math.max(0, Math.min(caret, text.length));
  for (let i = end - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (triggerChars.includes(ch)) {
      const before = i === 0 ? undefined : text[i - 1];
      const validStart = before === undefined || /\s/.test(before);
      if (!validStart) return null;
      return { trigger: ch, query: text.slice(i + 1, end), start: i };
    }
  }
  return null;
}

/** The range-math half of insertion — factored out so it is testable without a real textarea. */
export interface CompletionEdit {
  start: number;
  end: number;
  text: string;
  /** Caret position after the edit lands, relative to the full post-edit string. */
  caret: number;
}

export function computeCompletionEdit(start: number, caret: number, replacement: string): CompletionEdit {
  const text = `${replacement} `;
  return { start, end: caret, text, caret: start + text.length };
}

/**
 * Replace exactly `[start, caret)` in `textarea` with `replacement` + a
 * trailing space, then restore the caret immediately after it. Returns the
 * textarea's value post-edit so a controlled-input caller can sync its
 * React state (the DOM mutation here bypasses React's own value diffing).
 */
export function insertCompletion(textarea: HTMLTextAreaElement, start: number, caret: number, replacement: string): string {
  const edit = computeCompletionEdit(start, caret, replacement);
  if (typeof textarea.setRangeText === 'function') {
    textarea.setRangeText(edit.text, edit.start, edit.end, 'end');
  } else {
    // Fallback for environments without setRangeText (older engines / test doubles).
    textarea.value = textarea.value.slice(0, edit.start) + edit.text + textarea.value.slice(edit.end);
    textarea.selectionStart = textarea.selectionEnd = edit.caret;
  }
  textarea.focus();
  return textarea.value;
}

export interface MenuState {
  open: boolean;
  trigger: string | null;
  query: string;
  start: number | null;
  activeIndex: number;
  /** Trigger-char position dismissed via Escape; stays closed until the caret moves to a different trigger. */
  dismissedStart: number | null;
}

export const CLOSED_MENU_STATE: MenuState = { open: false, trigger: null, query: '', start: null, activeIndex: 0, dismissedStart: null };

/** Pure reducer transition: fold a fresh `detectTrigger` result into menu state. */
export function reduceDetection(state: MenuState, detected: DetectedTrigger | null): MenuState {
  if (!detected) return { ...CLOSED_MENU_STATE, dismissedStart: null };
  if (state.dismissedStart === detected.start) {
    return { ...CLOSED_MENU_STATE, dismissedStart: state.dismissedStart };
  }
  if (state.open && state.trigger === detected.trigger && state.start === detected.start) {
    // Same session, query just changed (typing/deleting) — keep the active index.
    return { ...state, query: detected.query };
  }
  return { open: true, trigger: detected.trigger, query: detected.query, start: detected.start, activeIndex: 0, dismissedStart: null };
}

/** Pure reducer transition: Escape dismisses the current session at its trigger position. */
export function dismissMenu(state: MenuState): MenuState {
  return { ...CLOSED_MENU_STATE, dismissedStart: state.start };
}

/**
 * Pure builder for the full combobox ARIA wiring — factored out so both the
 * open and closed states are unit-testable without rendering the textarea.
 */
export function comboboxAriaProps(open: boolean, activeOptionId: string | null, listboxId: string) {
  return {
    role: 'combobox' as const,
    'aria-expanded': open,
    'aria-controls': listboxId,
    'aria-activedescendant': activeOptionId ?? undefined,
    'aria-autocomplete': 'list' as const,
    'aria-haspopup': 'listbox' as const,
  };
}

// =============================================================================
// Hook
// =============================================================================

export interface TriggerSource<T> {
  /** Single trigger character, e.g. `@` for mentions or `/` for commands. */
  trigger: string;
  /** Synchronous search over the query text (no debounce — callers own their own data). */
  search: (query: string) => T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
}

export interface UseTriggerMenuResult<T> {
  isOpen: boolean;
  query: string;
  activeTrigger: string | null;
  items: T[];
  activeIndex: number;
  listboxId: string;
  activeOptionId: string | null;
  /**
   * Spread onto the textarea for the ARIA combobox wiring AND the
   * detection listeners. The listeners are plain React handler props
   * (not a native-DOM `useEffect` subscription) so they stay attached
   * across textarea remounts — e.g. the composer unmounting/remounting
   * when the session-history view is toggled — with no extra wiring.
   */
  comboboxProps: {
    role: 'combobox';
    'aria-expanded': boolean;
    'aria-controls': string;
    'aria-activedescendant': string | undefined;
    'aria-autocomplete': 'list';
    'aria-haspopup': 'listbox';
    onInput: (event: ReactFormEvent<HTMLTextAreaElement>) => void;
    onClick: (event: ReactMouseEvent<HTMLTextAreaElement>) => void;
    onKeyUp: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
    onSelect: (event: ReactSyntheticEvent<HTMLTextAreaElement>) => void;
  };
  /** Call from the textarea's onKeyDown. Returns true when the menu consumed the key
   *  (caller must not also treat it as a send/newline keystroke). */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  selectItem: (item: T) => void;
  close: () => void;
  /** Spread onto each rendered option (`role="listbox"` children). */
  getOptionProps: (index: number) => {
    id: string;
    role: 'option';
    'aria-selected': boolean;
    onMouseDown: (event: ReactMouseEvent) => void;
    onClick: () => void;
  };
}

const LISTBOX_ID = 'chat-trigger-menu-listbox';

/**
 * Caret-anchored trigger-menu combobox for a plain textarea — deliberately
 * NOT a contentEditable port. Detects an open `@`/`/`/etc. session by
 * scanning backward from the real caret on every input/selection change,
 * and inserts the chosen completion via `setRangeText` range math instead
 * of the old `split(' ')` heuristic. `triggers` is an array so a second
 * trigger (e.g. a `/` command menu) can be added without reworking this hook.
 */
export function useTriggerMenu<T>(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  triggers: TriggerSource<T>[],
  onInserted?: (value: string) => void,
): UseTriggerMenuResult<T> {
  const [state, setState] = useState<MenuState>(CLOSED_MENU_STATE);
  const triggerChars = useMemo(() => triggers.map((t) => t.trigger), [triggers]);

  const sync = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const detected = detectTrigger(el.value, el.selectionStart ?? el.value.length, triggerChars);
    setState((prev) => reduceDetection(prev, detected));
  }, [textareaRef, triggerChars]);

  const activeSource = useMemo(() => triggers.find((t) => t.trigger === state.trigger), [triggers, state.trigger]);
  const items = useMemo(() => (state.open && activeSource ? activeSource.search(state.query) : []), [state.open, state.query, activeSource]);
  const activeIndex = items.length ? Math.min(state.activeIndex, items.length - 1) : 0;

  const close = useCallback(() => setState((prev) => dismissMenu(prev)), []);

  const selectItem = useCallback((item: T) => {
    const el = textareaRef.current;
    if (!el || state.start === null || !activeSource) return;
    const caret = el.selectionStart ?? state.start + state.query.length + 1;
    const nextValue = insertCompletion(el, state.start, caret, activeSource.getLabel(item));
    setState(CLOSED_MENU_STATE);
    onInserted?.(nextValue);
  }, [state.start, state.query, activeSource, textareaRef, onInserted]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!state.open) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setState((prev) => ({ ...prev, activeIndex: items.length ? (prev.activeIndex + 1) % items.length : 0 }));
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setState((prev) => ({ ...prev, activeIndex: items.length ? (prev.activeIndex - 1 + items.length) % items.length : 0 }));
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const item = items[activeIndex];
      if (!item) return false;
      event.preventDefault();
      selectItem(item);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  }, [state.open, items, activeIndex, selectItem, close]);

  const activeOptionId = state.open && activeSource && items[activeIndex] ? `${LISTBOX_ID}-option-${activeSource.getId(items[activeIndex])}` : null;

  const getOptionProps = useCallback((index: number) => {
    const item = items[index];
    const id = item && activeSource ? `${LISTBOX_ID}-option-${activeSource.getId(item)}` : `${LISTBOX_ID}-option-${index}`;
    return {
      id,
      role: 'option' as const,
      'aria-selected': index === activeIndex,
      // Prevent the mousedown from stealing focus off the textarea before the click fires.
      onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
      onClick: () => item && selectItem(item),
    };
  }, [items, activeSource, activeIndex, selectItem]);

  return {
    isOpen: state.open,
    query: state.query,
    activeTrigger: state.trigger,
    items,
    activeIndex,
    listboxId: LISTBOX_ID,
    activeOptionId,
    comboboxProps: {
      ...comboboxAriaProps(state.open, activeOptionId, LISTBOX_ID),
      // React handler props (not native addEventListener) so detection
      // survives the textarea being unmounted/remounted (e.g. leaving and
      // reopening a session) — they attach fresh on every render, exactly
      // like the composer's other onChange/onKeyDown handlers.
      onInput: sync,
      onClick: sync,
      onKeyUp: sync,
      onSelect: sync,
    },
    handleKeyDown,
    selectItem,
    close,
    getOptionProps,
  };
}
