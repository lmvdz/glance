# Craft harvest — t3-face and PR #215 adoption list

Research-only output for `plans/the-room/21-craft-harvest.md`.

Sources read:
- `origin/plan/the-room:plans/the-room/21-craft-harvest.md` after `git fetch origin plan/the-room`.
- `/home/lars/sui/glance-desktop` t3-face branches/commits: C04 transcript cursor note; C05 thread spine; C07 server ladder; C08 composer shell; C09 timeline; C10 diff restyle branch present; C11 chrome polish.
- PR #215 metadata (`gh pr view 215 --json files,headRefName,baseRefName,title,state,url`) and `pr-215:plans/research-t3code/BRIEF.md`, especially Round 3.

## Keep list

### 1. Token grammar: server-tier status dots only

- **What:** Keep the C07 ladder token map as the room's status grammar: `error -> destructive`, `pending-approval -> warning`, `awaiting-input -> info`, `working -> info + duty-cycled pulse`, `plan-ready -> pending/violet`, `completed-unseen -> success`, `idle -> muted`.
- **Where:** Concerns 08, 12, 13, 14, 15, 16, 19, 23.
- **Verdict:** **Keep.** One token family lets proof cards, rail roll-ups, needs-you cards, gate verdicts, land cards, and unread/active affordances repaint consistently without raw palette drift.

### 2. Attention ownership: render server truth, do not re-rank client-side

- **What:** The cockpit deleted client ranking and became a pure renderer of daemon `ladderPriority`; group roll-ups use the same max-rung order, not a second heuristic.
- **Where:** Concerns 07, 08, 12, 19, 23.
- **Verdict:** **Keep.** The room is multiplayer; two clients inventing urgency differently would make the shared channel untrustworthy.

### 3. Rail row density: always-visible spine, dense rows, hover-reveal actions

- **What:** C05 row idiom: h-6/h-7 rows, active `bg-accent/85`, selected `bg-primary/15`, single-line truncation, trailing actions hidden until hover/focus with pointer-events swapped, group header roll-up dot that crossfades to chevron.
- **Where:** Concern 07, with carry into concern 19 unread/typing polish.
- **Verdict:** **Keep.** The room's left rail needs standing attention, not dashboard chrome; dense rows make active work legible without stealing the first frame.

### 4. Surface subheaders: fixed h-10 opaque band over scroll bodies

- **What:** C11 `.surface-subheader`: 2.5rem fixed-height row, hairline bottom border, `--background` fill, per-header padding/content via utilities.
- **Where:** Concerns 07, 08, 12, 13, 14, 15, 16.
- **Verdict:** **Keep.** Doors and channel panes need one chrome language; opaque subheaders stop grained/scrolling content from visually smearing under controls.

### 5. Channel scroll model: three named modes, not ad hoc stickiness

- **What:** PR #215 Round 3 scroll spec: `following-end`, `anchoring-new-turn`, `free-scrolling`; on send, pin the user's message near the viewport top with reserved trailing space so the response grows downward instead of re-scrolling per token.
- **Where:** Concern 08, verified by concern 23.
- **Verdict:** **Keep.** This is the modern-chat feel carrier; the current 40px bottom threshold style is too implicit for a room people will read all day.

### 6. Timeline row derivation: turn folds + work runs, monotonic fold state

- **What:** C09/PR #215 timeline shape: derive a flat discriminated union; previous settled turns fold behind `Worked for X` / `You stopped after X`; terminal assistant/result remains visible; consecutive tool entries collapse with `MAX_VISIBLE_WORK_LOG_ENTRIES = 1`; subagent/delegation entries never hide inside generic tool noise.
- **Where:** Concern 08 and all proof-card-adjacent streams in concerns 12-16.
- **Verdict:** **Keep.** The room must preserve the narrative beat while suppressing tool spam; monotonic folding prevents poll-settle flicker.

### 7. Tool-row polish: human display before raw logs

- **What:** PR #215 H2 v2 list: strip trailing `completed`, unwrap `bash -lc`/shell wrappers, suppress preview text that duplicates heading, render chevron only when expandable, show failure from explicit status or output heuristics, put raw args/result only behind an expand fold.
- **Where:** Concern 08; indirectly concern 12's Intervene door.
- **Verdict:** **Keep.** Lars reads reasoning/checks first; raw JSON and shell ceremony are door material, not the channel face.

### 8. Working indicator: three staggered duty-cycled dots + ref-mutated timer

- **What:** C09/CSS motion spec: three `bg-info` dots at 0/160/320ms using `animate-status-pulse`; live `Working for 2m 14s` text mutates `textContent` through a ref; keyframes use stepped long holds so animation produces frames only during short ramps; reduced-motion guard remains.
- **Where:** Concerns 08, 12, 23.
- **Verdict:** **Keep.** It reads alive without paying a React render or battery tax every second.

### 9. User message bubble: alignment, max width, long-message collapse

- **What:** C09/PR #215 feel carrier: user content right-aligned in `bg-secondary`, rounded-2xl, max width about 80%; long user messages collapse behind a gradient mask and explicit show-more control.
- **Where:** Concerns 08, 09, 10, 23.
- **Verdict:** **Keep.** Human messages must not be buried in system cards, and long prompts should not destroy channel scanability.

### 10. Card faces are instant; doors fetch depth lazily

- **What:** Room concern 08 already names pinned payload faces; t3-face/PR #215 reinforces the split with cards showing compact proof immediately and deep panes behind explicit actions.
- **Where:** Concerns 08, 12, 13, 14, 15, 16.
- **Verdict:** **Keep.** It preserves chat rhythm while making every proof inspectable; loading a door must never block the channel row.

### 11. Changed-files card recipe

- **What:** PR #215 H3 spec: mount under the assistant/proof row that changed files; sticky header with `N changed files`, inline `+x -y`, Expand/Collapse-all, and View diff; real path-segment tree with single-child directory-chain compaction; aggregate stats up folders; `+N -N` in aligned `grid-cols-[4ch_4ch]`; per-thread/per-turn expand state persisted with debounced localStorage; row-level store subscription.
- **Where:** Concern 16 first; also concern 12's Intervene door and concern 13 post-mortem proof mode.
- **Verdict:** **Keep.** This is the highest-taste way to show file impact as a card face without dumping full diffs into the room.

### 12. Bespoke diff renderer stays; no `@pierre/diffs`

- **What:** PR #215 explicitly re-validates the t3-face C10 decision: use the existing bespoke `DiffFile` stack; do not adopt `@pierre/diffs` or the Pierre icon workflow wholesale.
- **Where:** Concerns 12, 13, 16.
- **Verdict:** **Keep as a negative decision.** The room needs a coherent proof-card diff grammar, not a second renderer family imported for one card.

### 13. Layered-card empty states for real empty surfaces

- **What:** C11 `FleetEmpty`: icon card over two rotated ghost cards, shadcn Empty primitives, compact variant for narrow slots, static transforms only.
- **Where:** Concerns 07, 08, 12, 14, 15.
- **Verdict:** **Keep selectively.** Good for durable empty states and unavailable doors; skip it for tiny inline placeholders where it would compete with the chat.

### 14. Skeletons as one unison viewport sweep

- **What:** C11 `.skeleton`: fixed-background gradient sweep so multiple skeleton rows move as one continuous shimmer; fallback/kill-switch awareness for WebKitGTK; reduced-motion guard.
- **Where:** Concerns 07, 08, 12, 13.
- **Verdict:** **Keep.** Loading rows should feel like one surface preparing, not a dozen independent spinners.

### 15. Two-step destructive confirm pill

- **What:** C11 `ConfirmPill`: first click arms for 3s, second fires; blur disarms; warning token styling; transition-only; safe actions stay one-click.
- **Where:** Concern 10 working-agent queue-or-confirm; concern 12 takeover/interrupt door.
- **Verdict:** **Keep.** It matches the room's safety rule: destructive interruption needs friction, normal steering should not.

### 16. Composer glass geometry

- **What:** C08/PR #215 geometry: `p-px` outer frame rounded 22px; inner rounded 20px border; `chat-composer-glass` with card alpha 20% light / 45% dark; two-layer shadow; blur as a separable `chat-composer-shared-blur`; flat fallback when `backdrop-filter` is unavailable; round send button flips to destructive stop square.
- **Where:** Concerns 07, 09, 10, 23.
- **Verdict:** **Keep.** The composer is the room's command surface; shared glass makes steer/spawn/chat feel like one verb family.

### 17. Composer state stays string-canonical

- **What:** PR #215 composer construction: inline chips are decoration over a plain string; file mentions serialize as markdown links; terminal/context chips expand into text at send; Lexical is not the architecture to copy.
- **Where:** Concerns 09 and 10.
- **Verdict:** **Keep.** The room's audit trail is channel text plus typed command echoes; plain-string canonical state keeps mention steers inspectable and replayable.

### 18. Mention serialization as markdown-link text

- **What:** PR #215 suggests adopting markdown-link mention serialization (`[label](encodedPath)` style for file mentions; analogous stable text for agents/issues) while keeping the composer string-canonical.
- **Where:** Concern 10.
- **Verdict:** **Keep.** It gives copy/paste, persistence, and parser round-trips one representation instead of hidden editor state.

### 19. Pending-slot priority ladder above composer input

- **What:** PR #215 composer pattern: exactly one high-priority panel above input — pending approval, pending user input, or plan follow-up; approval details render untruncated in a scrollable `<pre>`; buttons are explicit; structured questions support number shortcuts and fast single-select progression.
- **Where:** Concerns 10, 12, 13, 23.
- **Verdict:** **Keep.** This turns the needs-you ladder into the composer itself instead of scattering answer widgets across the room.

### 20. Every surface feeds the composer

- **What:** t3code/t3-face pattern: selected terminal text, diff comments, preview annotations, and context chips become next-send input, not side-channel state.
- **Where:** Concerns 10, 12, 14, 16.
- **Verdict:** **Keep.** The room's control law is visible command in chat; context must enter through the composer so collaborators can see what happened.

### 21. Performance trio before visual polish

- **What:** PR #215 Round 3: structural-sharing pass for derived rows, row-shared state via contexts rather than prop churn, ref-mutated timers; row memoization alone is a no-op without stable row identities.
- **Where:** Concerns 08 and 23.
- **Verdict:** **Keep.** The love gate judges feel; stable rows are the invisible half of taste.

### 22. Minimap as conditional reading aid

- **What:** C09/PR #215 minimap: one dot per user message positioned by array index, hover-only/persistent-gutter-aware, preview card optional, no seq positioning because seq can have gaps.
- **Where:** Concern 08, later polish in concern 19 if channel volumes justify it.
- **Verdict:** **Keep later.** Correct for long channels, but not required for first-frame love; ship anchoring before rail candy.

### 23. Copy voice: durations and honest human labels

- **What:** C11 voice pass: `Working for 2m 14s`, `You stopped this unit`, `Hit an error`, next-step phrasing; avoid raw status/dev jargon.
- **Where:** Concerns 08, 12, 13, 16, 23.
- **Verdict:** **Keep.** The room is a human workspace; card text must say what Lars can do next, not what enum fired.

### 24. Context-window meter pattern

- **What:** PR #215 `ContextWindowMeter`: compact 24px SVG ring, blue-to-red near 90%, hover popover with token detail and compaction note.
- **Where:** Concern 15 or H7-style model/effort controls if they enter the room.
- **Verdict:** **Keep later.** Useful for agent-depth surfaces, but token burn cards are higher-value than per-thread meter chrome in the first room pass.

### 25. Descriptor-driven provider traits

- **What:** PR #215 model picker: provider instance, not driver kind, owns capabilities; effort/thinking/context/access traits render from descriptors.
- **Where:** Concern 10 mention spawn controls and later room-side harness controls; possibly concern 15 attribution.
- **Verdict:** **Keep later.** It prevents per-harness UI forks, but should ride the first real model/access control surface, not block the room root.

## Skip list

### 26. Skip wholesale t3-face CSS palette reset

- **What:** Full `t3face.css` palette, font, scrollbar, grain, and global defaults as a substrate.
- **Where:** Concerns 07/08 could be tempted to apply it globally.
- **Verdict:** **Skip.** The room should harvest tokens and motion specs, not import a desktop fork's global skin reset into the webapp without a separate brand/theme decision.

### 27. Skip raw-palette variants such as unused fuchsia skill chips

- **What:** C08 noted the t3 fuchsia skill chip variant was intentionally not used because it had no app analog and used raw palette colors.
- **Where:** Concern 10 skill/mention chips.
- **Verdict:** **Skip.** If a chip has no semantic room token, it is decoration debt.

### 28. Skip Lexical as a composer dependency

- **What:** t3code uses Lexical PlainTextPlugin and DecoratorNodes for inline chips.
- **Where:** Concerns 09/10.
- **Verdict:** **Skip.** PR #215's own transferable lesson is string-canonical state; the room can keep textarea/chip-tray mechanics unless measured input fidelity proves otherwise.

### 29. Skip message queue as reference behavior

- **What:** Round 3 corrected Round 2: web composer has no queue while a turn runs; running maps to Stop, not Queue.
- **Where:** Concern 10.
- **Verdict:** **Skip.** Glance's steer/confirm path is a capability lead; copying non-existent queue behavior would regress the product law.

### 30. Skip virtualization now

- **What:** t3code's timeline uses LegendList, but PR #215 records a 9-commit scroll saga and validates t3-face's deferred-virtualization call.
- **Where:** Concern 08.
- **Verdict:** **Skip until measured.** Channel volumes start lower than unit transcripts; virtualizing before anchoring/perf identity is premature complexity.

### 31. Skip full markdown pipeline port

- **What:** t3code's `ChatMarkdown.tsx` is a deep stack: react-markdown/GFM/plugins, Shiki via `@pierre/diffs`, selection-to-markdown copy, table tooling, code headers, file-link resolution.
- **Where:** Concern 08.
- **Verdict:** **Skip wholesale.** Keep the hand-rolled `.chat-markdown` typography and copy ideas selectively; do not make the room's first timeline depend on a 1,500-line renderer transplant.

### 32. Skip full-access-by-default product stance

- **What:** t3code optimizes for one-command direct work on cwd with full access by default.
- **Where:** Concerns 09/10 spawn and steer paths.
- **Verdict:** **Skip.** The room is multiplayer and auditable; every control-plane verb needs visible ack/echo and trust-boundary handling.

### 33. Skip mobile-only View Transitions hero morph

- **What:** PR #215 draft hero uses View Transitions API on mobile; desktop relayouts.
- **Where:** Concerns 07/09.
- **Verdict:** **Skip for this webapp pass.** A polished empty prompt is useful; a transition trick is not on the love-gate axis.

### 34. Skip no-avatar absolutism

- **What:** t3code role is alignment, not avatars.
- **Where:** Concern 09 presence and concern 19 multiplayer polish.
- **Verdict:** **Skip as a hard rule.** Human presence needs identity; use quiet avatars/counts where they carry multiplayer meaning, while keeping agent/user message alignment clear.

## Recommendation on PR #215

**Recommend merge.** PR #215 is docs-only research (`plans/research-t3code/BRIEF.md` plus plan-status pointer edits) and the Round 3 material is directly load-bearing for concerns 08, 10, 16, and 23. It also corrects a prior false borrow about web message queueing, which reduces implementation risk. Merging remains Lars's call, but from this harvest there is no source-code risk and substantial reference value.
