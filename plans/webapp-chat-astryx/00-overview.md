# Webapp chat upgrade (astryx-derived)

## Outcome
- The chat stops yanking the viewport during agent runs; a "jump to latest" pill appears when you've scrolled up.
- Operators can stop a running agent from the composer; streaming is screen-reader usable.
- Long tool-call chains collapse; streaming markdown never flashes torn syntax.
- @-mentions work with multi-word task titles; the 1,396-line monolith becomes `components/chat/`; one message model replaces the dual-store hack.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 memo-and-clock | Whole panel re-renders every WS frame + every 1s tick; localStorage rewritten per frame | mechanical | AssistantChat.tsx |
| 02 scroll-hooks-port | Port astryx scroll lock machinery (MIT, dependency-free) | mechanical | new hooks/chat/*, lib/sharedResizeObserver.ts |
| 03 scroll-wire | Replace unconditional scrollIntoView with lock/pill behavior | architectural | AssistantChat.tsx |
| 04 stop-and-a11y | Stop control in composer; role=log/aria-busy; remove no-op buttons | mechanical | AssistantChat.tsx |
| 05 tool-collapse | Tool chains dominate transcripts; collapse to latest+count | architectural | new chat/ToolCallGroup.tsx, AssistantChat.tsx |
| 06 streaming-markdown-util | Artifact suppression + settled boundary as pure functions | research | new lib/streamingMarkdown.ts |
| 07 settled-markdown-wire | Scope suppression to the tail; bound re-parse | mechanical | AssistantChat.tsx |
| 08 mention-combobox | @-mention heuristic is admittedly broken; no ARIA | architectural | new hooks/chat/useTriggerMenu.ts, AssistantChat.tsx |
| 09 monolith-split | One file owns the whole chat; TaskDetail couples to it | mechanical | new components/chat/*, AssistantChat.tsx, TaskDetail.tsx |
| 10 single-message-model | Dual store + context-polluted echo + replay double-render | architectural | AssistantChat.tsx, chat/*, src/squad-manager.ts, dto |
| 11 usesquad-hardening | Reconnect resumes only one subscription; cap-eviction reorders | mechanical | hooks/useSquad.ts |
| 12 composer-bundle | Auto-grow, history recall, paste-as-chip | mechanical | chat/Composer.tsx |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02, 06, 11 | Disjoint files; 01 opens the hot-file chain, others are new-file/other-file |
| 2 | 03 | Hot file; needs 01 (chain) + 02 |
| 3 | 04 | Hot file |
| 4 | 05 | Hot file (small integration edit; ToolCallGroup is a new file) |
| 5 | 07 | Hot file; needs 06 |
| 6 | 08 | Hot file |
| 7 | 09 | Hot file — the split; everything before it has settled |
| 8 | 10, 12 | Post-split; disjoint (10 = model+server, 12 = Composer only) |

`AssistantChat.tsx` is the hot file: 01→03→04→05→07→08→09→10 is a strict linear chain — never dispatch two of these to parallel worktrees.

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | — | — |
| 03 | 01, 02 | `ls webapp/src/hooks/chat/useChatStreamScroll.ts` exists; 01 closed |
| 04 | 03 | 03 closed (same file region) |
| 05 | 04 | 04 closed (chain) |
| 06 | — | — |
| 07 | 05, 06 | `ls webapp/src/lib/streamingMarkdown.ts`; 05 closed |
| 08 | 07 | 07 closed (chain) |
| 09 | 08 | 08 closed; hot file quiet |
| 10 | 09 | `ls webapp/src/components/chat/TranscriptTimeline.tsx` exists |
| 11 | — | — |
| 12 | 09 | `ls webapp/src/components/chat/Composer.tsx` exists |

## Completion (2026-07-04)
- 12/12 concerns closed. Executed via workflow (25 agents: 12 implementers, per-batch fable reviews, fixers, committers), then audited: /code-review high (10 CONFIRMED findings) + cross-batch audit (2 significant) → all fixed in a 3-commit review-fix wave (114e898, c2c3fb0, 004616c).
- Biggest post-review catches: seq-based cap guard froze the chat after daemon restart; destructive localStorage migration lost user turns; pending/failed sends invisible in the collapsed work fold; durable transcript lost the real agent prompt.
- Final state: webapp 461 tests green, root suite at pre-existing baseline (2 known spawn flakes), tsc clean both sides, build clean.
- Operational: the daemon must be reinstalled/restarted to serve `displayText` echoes (webapp degrades gracefully against an old daemon — full message shown, as before).
- Known accepted residue (audit minors): history recall is mount-scoped; one-frame flicker on send-to-idle; 2nd+ user turns still fold into the collapsed work section (pre-existing timeline design, first prompt + trailing sends always visible).

## Notes
- WIP snapshot at plan time (headless chained run, gate logged not asked): 3 plans with 10 open concerns (agentic-learning-loop 5, factory-control-plane 3, change-driven-loops 2), all dated 2026-07-03. Proceeded per the /research → /plan chain the user requested.
- Sign-offs assumed (flag on land if contested): drop thumbs-up/down reactions; remove decorative attach/mic buttons until composer work makes attach real.
- Cut from scope (see DESIGN.md): TaskDetail scroll wiring, streaming fade-in, dictation, chat token/color migration (deferred to ember rebrand).
- Concern 10 includes a small daemon change — the daemon runs the global install; restart is part of its verify.
