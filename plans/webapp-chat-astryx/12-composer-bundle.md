# Composer quality bundle: auto-grow, history recall, paste-as-chip
STATUS: closed
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/Composer.tsx, webapp/src/components/chat/Composer.test.tsx

BLOCKED_BY: 09

## Goal
The composer behaves like a daily-driver console input: grows with content, recalls prior prompts terminal-style, and turns large pastes into a chip instead of flooding the textarea.

## Approach
All inside `chat/Composer.tsx` (exists after concern 09). Three independent features — implement as separable commits; any can ship alone.
1. **Auto-grow**: textarea height tracks content (set `height:auto` then `scrollHeight` on input) up to 8 lines, then scrolls; replaces the fixed `min-h-12 max-h-40` behavior. Reset height on send/clear.
2. **History recall**: ArrowUp at caret position 0 (and ArrowDown at end) cycles the current session's prior *user* prompts, newest first. Preserve the in-progress draft (index −1 slot) and restore it when cycling back down; select-all on recall (terminal convention). Suppressed while the mention menu (08) is open. Source: the session's user turns (post-concern-10: mapped messages + transcript user entries + pending sends — take texts, most recent N=50).
3. **Paste-as-chip**: a paste > 200 chars becomes an attachment chip above the textarea (name like "Pasted text · 3.2 KB", preview on click/hover, ✕ to remove, "insert inline" escape hatch) instead of entering the textarea. On send, append chip contents to the outgoing `text` (fenced, after the typed message) before the context blob assembly. Multiple chips allowed. This is the honest home for "attach" (the decorative button was removed in 04).

## Cross-Repo Side Effects
None (chips are folded into the prompt text; no DTO change).

## Verify
- `bun test`: history-cycle reducer (draft preservation, bounds, newest-first); paste-length threshold routing; send-text assembly with chips (fencing, order).
- Static markup: chip renders with remove control; textarea rows/height attributes sane.
- Manual: paste a long diff → chip, not text-flood; send → agent receives full content; ArrowUp recalls, editing a recalled prompt then ArrowUp again preserves nothing unexpected; auto-grow caps at ~8 lines.

## Resolution
Implemented all three composer features in webapp/src/components/chat/Composer.tsx: auto-grow textarea (up to 8 lines, resets on send/clear), history recall via ArrowUp/ArrowDown over prior user prompts with draft preservation, and paste-as-chip for pastes over 200 chars with fenced inline insertion on send. Covered by webapp/src/components/chat/Composer.test.tsx.
