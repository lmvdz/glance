# Caret-anchored trigger-menu combobox for @-mentions
STATUS: open
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
