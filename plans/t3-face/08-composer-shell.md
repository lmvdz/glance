# Composer shell — t3 glass geometry + drafts that survive

STATUS: open
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 01, 03
TOUCHES: src/modules/fleet/IntervenePane.tsx, src/modules/ai/components/AiComposerInput.tsx, src/modules/ai/lib/composer.tsx, src/components/composer/* (new shared shell), a draft-persistence store

## Goal

Both composers — the AI chat composer and the fleet steer composer — render in t3's glass geometry (rounded frame, focus-ring border, footer toolbar, round send button that flips to a stop square while running), share one presentational shell, and never lose typed text. Fixes a live law-5 data-loss bug: steer text is destroyed when a selected unit lands and IntervenePane unmounts.

## Approach

Reference: `/tmp/t3/components_chat_ChatComposer.tsx` (geometry), `composerInlineChip.ts` (pure class-string chip module — ports verbatim, MIT notice), `composerDraftStore.ts` (persistence shape). Do NOT port Lexical — decision locked in DESIGN.

1. **Shared shell `src/components/composer/ComposerShell.tsx`**: presentational only — outer frame `rounded-[22px] p-px`, glass surface `chat-composer-glass rounded-[20px] border has-focus-visible:border-ring/45` (classes from concern 01), a slot for the input, a chip strip **below** the input (chip-tray compromise — a `<textarea>` can't host inline chips; `composerInlineChip.ts` styles the tray chips), and a footer toolbar (left slot for pickers/toggles, right slot for primary actions). Send button `h-9 w-9 rounded-full bg-primary/90` with the hand-drawn arrow; running → `bg-destructive/90` stop square; disabled at `opacity-30`.
2. **Adopt in the AI composer**: wrap the existing autoresizing textarea + `AiComposerProvider` affordances (voice, @-mentions, #/slash pickers, attachments) in the shell. Behavior unchanged; only the frame/footer/chips move into the shell. Context chips move to the tray.
3. **Adopt in the fleet steer composer**: replace IntervenePane's plain `<textarea>` (⌘/Ctrl+Enter steer) with the shell.
4. **Draft persistence** (in scope — resolves the designer's open question): a small zustand `persist` store (localStorage) OR `tauri-plugin-store` matching the app's session-persistence pattern, keyed per unit/thread, versioned with a migrate stub (t3 is at v8 for a reason). **Survival requirement**: steer draft must persist across IntervenePane unmount — when a selected unit lands/vanishes and selection force-clears (`RosterView`/`FleetLayout`), the in-progress text is saved and restored if the unit reappears or on reselect. This is the law-5 fix, not a nice-to-have.
5. No queue toggle (t3 has none): while running, Enter still sends as a steer (matches both t3 and current fleet behavior).

## Cross-Repo Side Effects

None.

## Verify

- Live: type in the fleet steer composer, force the unit to land (or interrupt→land) mid-typing → text is preserved (reselect shows it). Regression demo: same flow on the pre-change build loses it.
- Both composers render identical glass geometry in light/dark; send↔stop flip works; chips render in the tray.
- AI composer voice/mentions/slash/attachments still function (no capability regression).
- Taste-lane review; `pnpm lint && check-types && vitest run && build` green.
