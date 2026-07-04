# Caret-anchored trigger-menu combobox for @-mentions
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/hooks/chat/useTriggerMenu.ts (new), webapp/src/hooks/chat/useTriggerMenu.test.ts (new), webapp/src/components/AssistantChat.tsx, webapp/src/components/AssistantChat.test.tsx

BLOCKED_BY: 07

## Goal
@-mentions work on a plain textarea via real caret tracking — multi-word task titles, mid-string edits, full combobox ARIA — replacing the `setTimeout(0)` + `split(' ')` heuristic the code itself admits is a placeholder (`AssistantChat.tsx:1048`).

## Approach
1. **`useTriggerMenu(textareaRef, triggers)`** (new hook, textarea-native — deliberately NOT a contentEditable port; DESIGN.md rejects that complexity tax):
   - Detection: on input/selection change, scan backward from `selectionStart` for an unconsumed trigger char (`@`) preceded by start-of-text or whitespace; the query is `[triggerPos+1, selectionStart)`. Pure function `detectTrigger(text, caret, triggerChars)` → `{trigger, query, start} | null` — unit-testable without DOM.
   - Insertion: `insertCompletion(textarea, start, caret, replacement)` replaces exactly `[start, caret)` via `setRangeText`, restores caret after the inserted text + trailing space.
   - Menu state: open/close, active index, ArrowUp/Down/Enter/Escape/Tab handling while open (composer's Enter=send must be suppressed while the menu is open).
   - Extensible `triggers` array so a `/` command menu can be added later without rework.
2. **ARIA (full combobox pattern)**: textarea gets `role="combobox"`(-equivalent wiring: `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`, `aria-haspopup="listbox"`); menu is `role="listbox"` with `role="option"` items, `mousedown.preventDefault()` on options so focus never leaves the textarea.
3. **Replace** the existing mention machinery: `showMentions`/`mentionQuery` state (`~L793-795`), `handleKeyDown` mention branch + `insertMention` (`L1038-1071`), popup JSX (`L1324-1346`). Task filtering (`filteredTasks`) becomes the trigger's search source — keep it synchronous over `tasks` from context.
4. Anchor the popover to the caret if cheap (mirror-div measurement), otherwise above the textarea as today — positioning is not the point of this concern; correctness and ARIA are.

## Cross-Repo Side Effects
None.

## Verify
- `bun test`: `detectTrigger` (mid-string edits, multi-word queries with spaces up to the caret, `@` inside a word not triggering, escape-then-retype); `insertCompletion` range math; menu-state reducer transitions.
- Static markup: ARIA attributes present in open and closed states.
- Manual: type `@` mid-sentence with text after the caret; pick a multi-word task title; edit inside an earlier mention; Escape closes without inserting; Enter with menu open selects instead of sending.

## Resolution

Shipped `useTriggerMenu(textareaRef, triggers, onInserted?)` in `webapp/src/hooks/chat/useTriggerMenu.ts`:

- Pure `detectTrigger(text, caret, triggerChars)` scans backward from the real caret for the nearest trigger char preceded by start-of-text/whitespace, stopping at a newline; the query runs `[triggerPos+1, caret)` and *can* contain spaces (multi-word task titles), while `user@domain.com` correctly does not trigger.
- Pure `computeCompletionEdit`/`insertCompletion(textarea, start, caret, replacement)` replace `[start, caret)` via `setRangeText` (with a manual-splice fallback), restore the caret after the inserted text + trailing space, and return the post-edit value so the controlled `input` state can be resynced (`onInserted`) without React's value diffing fighting the DOM mutation.
- Pure `reduceDetection`/`dismissMenu` menu-state reducer: opens/updates/closes a session, and tracks a `dismissedStart` so Escape-then-keep-typing-the-same-query stays closed until the trigger moves or a new trigger position appears (escape-then-retype).
- `handleKeyDown` in the hook consumes ArrowUp/Down (circular nav), Enter/Tab (select), Escape (dismiss) while open, returning `true` so the composer's own Enter-sends-message handling is suppressed only while the menu is open.
- Full ARIA combobox wiring via pure `comboboxAriaProps(open, activeOptionId, listboxId)`: textarea gets `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`, `aria-haspopup="listbox"`; the popup is `role="listbox"` with `role="option"` items via `getOptionProps(index)`, each with `onMouseDown={preventDefault}` so focus never leaves the textarea.
- `AssistantChat.tsx`: removed `showMentions`/`mentionQuery` state, the old `handleKeyDown` mention branch + `setTimeout(0)`/`split(' ')` `insertMention`, and `filteredTasks`; replaced with a `composerTextareaRef`, a `mentionTriggers` (`TriggerSource<Task>[]`) memoized over `tasks`, and `mentionMenu = useTriggerMenu(composerTextareaRef, mentionTriggers, setInput)`. The popup JSX now renders `mentionMenu.items` with `getOptionProps`/`comboboxProps` spread in; positioning stays anchored above the textarea as before (mirror-div caret anchoring was not pursued — correctness/ARIA were the point of this concern, per the Approach note).
- Tests: `webapp/src/hooks/chat/useTriggerMenu.test.ts` (19 → 22 cases after the ARIA additions) covers `detectTrigger` (mid-string edit, multi-word query with spaces, `@`-inside-a-word non-trigger, newline boundary, start-of-text, multi-trigger-char filtering), `computeCompletionEdit`/`insertCompletion` range math (via a duck-typed fake textarea, no jsdom), the menu-state reducer transitions including escape-then-retype, and `comboboxAriaProps` in both open and closed states.
- `bun test` (webapp): 405 pass, 0 fail. `tsc --noEmit`: clean.

Anomaly noted to the orchestrator (not touched, not part of this commit): `webapp/src/components/TaskDetail.tsx` had an unrelated 8-line staged deletion (a `now`/clock-tick effect) already present in the index before this concern started — pre-existing dirty state from something else, out of scope for concern 08, left as-is.
