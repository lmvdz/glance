# Timeline rewrite — reasoning-first turn-fold conversation

STATUS: open
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 01, 04
TOUCHES: src/modules/fleet/ConversationView.tsx, src/modules/fleet/timeline/* (new logic + rows), reuse of src/components/ai-elements/*

## Goal

The fleet detail transcript reads like t3code's timeline: finished turns collapse behind labelled folds (latest stays expanded), tool calls group into work rows ("+N previous tool calls"), assistant reasoning renders in a collapsible block, markdown is real (not whitespace-pre), a working row shows staggered pulse dots + a live "Working for Xs" timer, and a right-edge minimap of user-message dots scrubs the conversation. This is the reasoning-first reading surface the daily-driver laws call the default review surface.

## Approach

Honest framing (per red team): this is a **rewrite** of ConversationView, not a CSS layer over it. Reference: `/tmp/t3/components_chat_MessagesTimeline.logic.ts` (601 lines of fold derivation with explicit anti-flicker guards) and `MessagesTimeline.tsx`. Reuse the fork's ai-elements (`conversation`, `message`/Streamdown, `reasoning`, `tool`) as the row renderers; port t3's *derivation logic*, not its `@legendapp/list` virtualization (deferred — polled cockpit transcripts don't need it).

1. **Requires concern 04** (cursor fix): fold/work/working states read entry `status` — frozen "running" states would break every derivation. Verify the fix is merged (`grep runningFloor …store`).
2. **Row derivation `timeline/deriveRows.ts`** (port from the logic file, adapt inputs to the widened transcript type): discriminated rows — `work` (grouped tool entries, only last `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` shown, "+N previous" toggle), `turn-fold` (boundary = each `kind:"user"` entry; finished turns collapse; latest/unsettled stays expanded), `message`, `working`. Carry over the anti-flicker guard ("folding must not flicker through that window") as a **named unit test**, and the steer-interrupted label ("You stopped after Xm").
3. **turnId availability**: fold boundaries derive from `kind:"user"` entries (verified present). Confirm foreign/ACP-harness transcripts also emit user-boundary entries; if a harness lacks them, folding degrades to a flat list gracefully (no crash) — test this explicitly.
4. **Rows**: user = right bubble `rounded-2xl bg-secondary max-w-[80%]` with mask-fade collapse for long messages; assistant = no bubble, plain markdown + reasoning block (ai-elements `reasoning` auto-collapse) + optional changed-files summary; working = 3 staggered `animate-status-pulse` dots + ref-ticking timer span (no React commit per second).
5. **Minimap**: right-edge rail of user-message dots, positioned **by array index, not seq** (seq is manager-global with gaps — red-team verified), scroll-to on click.
6. Markdown: reuse the fork's Streamdown renderer; if code-block fidelity needs shiki it comes with concern 10's pierre highlighter — do not add a second highlighter here.

## Cross-Repo Side Effects

None (consumes the widened transcript from concern 04).

## Verify

- Unit tests: fold derivation over a multi-turn transcript (finished turns fold, latest expanded, no flicker across the settle window); work grouping; graceful flat-list fallback when user-boundary entries absent.
- Live (scratch daemon, tool-using multi-turn unit): folds, work rows, reasoning collapse, working timer, and minimap all behave; switching units repaints correctly (concern 04 + 05 prewarm).
- Taste-lane review vs live `npx t3` timeline (concern 13 video).
- `pnpm lint && check-types && vitest run && build` green.
