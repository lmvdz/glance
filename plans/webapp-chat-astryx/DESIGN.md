# Design: webapp chat upgrade (astryx-derived)

Origin: `plans/research-astryx-chat/BRIEF.md` (PR #26). Adversarial design run 2026-07-03: sonnet designer draft, two fable red teams, fable arbiter. This document is the arbitrated result.

## Approach

Behavior-first, structure-later, re-ranked by operator value. New code is born in its final home (`webapp/src/hooks/chat/`, `webapp/src/lib/`); existing monolith code moves once, in a single split concern, after the behavior fixes stop churning it. Everything that touches `AssistantChat.tsx` lands as one linear chain — never parallel worktrees on the hot file. New-file concerns (hook port, streaming-markdown util, tool-call group) run in parallel with the chain.

The plan ships, in order of operator value: no more viewport yanking (scroll lock + jump-to-latest pill), render-cost fixes (memoized entries, clock leaf), a stop control, screen-reader-usable streaming, collapsed tool chains, torn-markdown suppression, a real @-mention combobox, then the structural payoff (monolith split, single message model).

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Scroll fix | Port astryx's 3 files (568 lines, MIT, dependency-free) verbatim + adapt | Reimplement from prose; minimal isNearBottom check | Spring math, event ordering, synthetic-scroll filter are production-tuned; minimal version recorded as fallback if the port stalls |
| Perf order | `React.memo(TranscriptEntryView)` + clock-leaf first; settled-prefix split second | Settled-prefix as the headline perf fix | Red team: nothing in the file is memoized — memo is the 80%; per-turn strings are KB-scale. Settled-split's primary value is scoping artifact suppression to the tail |
| Stop semantics | Composer button = graceful `interrupt` with debounced "stopping…"; no auto-escalation; `kill` stays a separate deliberate affordance | Second press escalates to kill | Interrupt already hard-kills workflow-driver agents (`abort()`=`killChild`); double-click must never destroy a run. Reuses existing `agent-control.ts` — this is relocation, not new capability |
| Single message model | Replay-as-truth: once a session has an `agentId`, stop writing user turns to localStorage; server transcript (replayed on subscribe, persisted) is the record. Read-time mapper covers pre-agent sessions | Render-time merge of both stores by `clientTurnId` | Red team proved `subscribe` replays the full persisted transcript — merging both stores double-renders every turn after refresh |
| Echo display text | Small daemon change: prompt carries the user's typed text separately from the context-augmented message; echoed transcript entry shows the typed text | Client-side text reconciliation | Server currently echoes the multi-KB context blob as the user entry; no client-side dedupe can undo that. One-line-scale server fix is the honest one |
| Optimistic sends | In-flight-only pending entries, appended at the end, cleared by `clientTurnId` match on user-kind echoes | Prepend (designer draft); hide-trick (status quo) | Prepend renders new sends at the top of the transcript; hide-trick is the bug being fixed |
| Test substrate | No jsdom/happy-dom added. Ported hooks expose pure decision functions (scroll-event classification, lock transitions, boundary math) unit-tested under `bun test`; DOM behavior covered by scripted manual flows | Add happy-dom; Playwright | DOM emulators return zero layout metrics — they cannot exercise the spring/filter; infra would test mocks |
| Monolith split | One concern, sequential commits, pure moves + one declared state-relocation (composer state moves into `chat/Composer.tsx`) | Three separate move PRs; lazy splitting | Acceptance: existing tests pass unmoved-or-colocated; no `chat/ → ../AssistantChat` imports (cycle guard) |
| Markdown boundary | Paragraph-level boundaries only (blank line at column 0, next line unindented and not a list continuation) | Any blank line outside a fence | Loose lists and indented continuations across the seam mis-parse in a two-tree render |
| Scope cuts | No TaskDetail scroll wiring; no fade-in; no dictation; token/color migration deferred to the ember rebrand pass (data attributes ride along now) | Full 16-concern plan | TaskDetail has no scroll bug today and its per-agent loop needs a wrapper component; fade-in requires remark-internal plumbing mispriced as CSS; dictation is Chrome-only and ships audio to Google |
| Reactions | Drop thumbs up/down; strip residue in session normalization | Add `reaction` to `TranscriptEntry` | Local-only UI state on a shared transport DTO; verified unwired to any backend. Visible feature cut — flagged for sign-off |

## Risks

- **Hot-file chain length**: seven concerns edit `AssistantChat.tsx` serially. Mitigation: each is small and independently landable; new-file concerns proceed in parallel.
- **Scroll port edge cases**: `scrollend` absent on older engines (degrades to pill-only re-lock — accepted); width-only ResizeObserver fires during panel resize (manual verify); transcript-cap front-trimming shrinks scrollHeight (pure-function test).
- **Session switching**: scroll container is keyed by session so lock state can't leak across sessions (red-team catch — the container never remounted).
- **localStorage persistence rides in the effect being replaced** — explicitly split first (also fixes per-WS-frame re-serialization).
- **Daemon change dependency**: single-message-model needs the display-text echo change deployed; the daemon runs the global install, so restart is part of that concern's verify.
- **Two-tree markdown seam**: reference links/footnotes defined in the settled prefix don't resolve in the tail until stream end (accepted, documented); fences remount once when crossing the boundary (accepted — one highlight flash).
- **Reconnect**: only the last-subscribed agent resumes on WS reopen (single `subscribedRef` slot) — fixed in the useSquad hardening concern; without it a locked region silently freezes after reconnect.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| `subscribe` replays persisted transcript → dual-store merge double-renders | critical | Single-model redesigned: replay-as-truth, stop double-writing (concern 10) |
| Server echoes context-polluted message as user entry | critical | Daemon display-text change folded into concern 10; C2 re-scoped as webapp+server |
| `mergeOptimistic` prepends new sends to the top | critical | Append-at-end, in-flight-only, ordering test required |
| Stop button premise false; double-press-kill footgun; driver-divergent interrupt | critical | Reframed as relocation of existing `agent-control.ts`; debounce, no escalation, kill separate |
| Priority inversion (tool collapse + mention fix behind 9-deep chain) | critical | Re-ranked; both unblocked from the split; A3/A4 merged |
| Hook tests unrunnable (no DOM env; emulators lack layout) | critical | Pure-function extraction + manual flows; no phantom jsdom prerequisite |
| TaskDetail wiring = rules-of-hooks violation + scope creep | significant | Cut from plan; optional follow-up |
| Session-switch lock-state leak; persistence coupled to scroll effect | significant | Container keyed by session; persistence effect split first (concern 01) |
| `SettledMarkdown` breaks pure-move split (import cycle) | significant | Split manifest includes it; cycle guard in acceptance |
| D1 isolation false (composer state lives in parent) | significant | Split declares composer state-relocation; mention combobox sequenced in the hot-file chain |
| Two-tree seam divergences (ref links, loose lists, fence remount) | significant | Paragraph-level boundary rule + the three cases as required unit tests |
| Settled-memo perf claim overstated; clock re-render dropped | significant | Claim corrected; memo+clock is its own first concern |
| Reconnect single-slot subscribe; cap-eviction reordering | significant | useSquad hardening concern |
| `clientTurnId` overloaded by gate answers | minor | Covered-set restricted to user-kind prompt echoes; gate-answer test required |
| Fade-in mispriced; dictation resume-driven; token pass double-work | significant/minor | All three cut |

## Open Questions

None blocking. Two sign-offs flagged (not blockers, decided unless overruled): dropping thumbs-up/down reactions; removing the decorative attach/mic buttons until a composer concern makes attach real.
