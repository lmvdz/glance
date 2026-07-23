# the-room — Phase 1 landscape (2026-07-22)

Input to the adversarial design round. Facts verified against main at commit 34abc8d unless noted.
Two Explore agents (daemon/event side, shell/render side) produced the citations below.

## The grand design (Lars, 2026-07-22, this session — supersedes parts of DIRECTION.md pending his review)

Two-layer product. **Layer 1 (buzz's role): the front-facing surface is a collaborative chat
workspace** — Slack-shaped channels where humans and agents are peers; typical users use it as
collaborative chat with the ability to spin up agents to do things; they never leave this layer.
**Layer 2 (glance + t3code's roles): depth surfaces entered from chat.** glance's depth: dig into
what an agent has prepared — plan/workflow DAG, modify the design, token burn across the entire
fleet. t3code's depth: the programmer's view — which agents are active, which are waiting,
transcripts, diffs, steer.

Extrapolated invariants (played back to Lars, not contradicted; treat as design spine, red-teams
should still attack them):
- Cards are doors: every layer-2 surface is a drill-in from a chat object, never the home screen.
- Layer 2 never happens silently: any action in a depth surface emits a card back into the room.
  Layer 1 is the complete projection of the system.
- Cards are proofs, not agent self-reports: gate verdicts, done-proofs, land assessments from the
  trust layer. This is glance's differentiation vs buzz; the daemon brain is NOT rebuilt.
- Delete-not-port: old webapp panels are not ported into the new shell; surfaces earn their way
  back when a card needs a door.
- No Nostr/buzz-relay adoption (research-buzz verdict: second platform — Rust relay + Postgres +
  Redis, prototype maturity, org-confinement mismatch). Borrow the shapes. A cheap ACP bridge
  spike (buzz-acp drives ACP agents; glance speaks ACP) is on the table to FEEL buzz's layer-1 UX
  before committing pixels — spike, not dependency.
- "Typical users" = multiplayer: multiple humans per org in shared channels. Glance already has
  orgs/auth/DB-mode tenancy; missing layer-1 primitives are channels not bound to a unit,
  presence, human↔human messages.

## Fact A — two frontends; the t3-shell plan targets the other repo

- `webapp/` (this repo, GLANCE_WEBAPP=1, React 19 + Vite + Tailwind v4) is the live daemon-served
  UI. All chat/steer/dispatch code below is CODE on main here.
- `glance-desktop` (separate repo, Tauri + terax IDE frame) is the target of plans/t3-face
  (concerns 01–10 DONE as a reskin *inside* the IDE frame; 11 in flight; 12 deferred; 13 = Lars
  acceptance gate, open) and plans/hub-shell H0–H7 (thread-client-as-root, IDE-as-mode — ALL
  concerns open, zero code).
- t3code R3 research (H3 changed-files card spec, three-part timeline perf system, scroll
  anchoring modes, string-canonical composer, no-web-queue finding) is PR #215 — OPEN, docs-only,
  not on main. Reference intel, not code.
- webapp already renders typed cards, not bubbles: `TranscriptTimeline.tsx` folds turns and
  renders kind-typed entries; `ToolCallGroup.tsx`, `GateWidget.tsx`, `DiffReviewPanel.tsx`,
  `SpawnProposalCard/SpawnConfirmSheet/SpawnStatusCard`, `TodoPanel`, `AgentMetaBar` exist.
  No projects→threads rail (closest: `WorkspaceCockpit.tsx` state-grouped roster). Side chat =
  `AssistantChat.tsx` right-docked panel; nav rail = `WorkbenchPane.tsx` view switcher.
- webapp conventions: bun test, DOM-free component tests (no jsdom/testing-library — pure
  extracted logic co-located `*.test.ts(x)`), no state library (hooks + Context + hand-rolled
  localStorage stores: `sessionStore.ts`, `draftStore.ts` schema v1 with 300ms debounce +
  beforeunload flush), no storybook; visual verification = scratch-daemon + agent-browser.

## Fact B — daemon/event substrate (all src/ paths, CODE on main)

- Transcript: `TranscriptEntry` at `src/types.ts:186-207`; `TranscriptKind = user | assistant |
  thinking | tool | system` (`:162`) — no verdict/land/review/peer kind exists. Single append
  chokepoint `SquadManager.append` at `src/squad-manager.ts:10791-10812` (redacts, seq, trims,
  emits `{type:"transcript"}`). Live-stream entries bypass append at `:8257-8338`.
- Settle-on-exit: `settleRunningEntries` (`src/transcript-delta.ts:33-40`) mutates still-`running`
  entries in place; delta pollers only re-fetch `running` entries → **new emitted entries must be
  born settled; append-only, never coalesce in place** (buzz-borrows red-team finding, confirmed).
- `SquadEvent` union at `src/types.ts:1471-1483` (12 variants: roster/agent/removed/transcript/
  log/commands/features-changed/comment/comment-resolved/audit/automation/transition).
- WS fan-out: file mode `broadcast` (`src/server.ts:3223-3235`); DB mode per-org `broadcastTo`
  (`:3239-3253`) wired via `registry.onEvent` (`:1322`). **Any new event surface must route
  broadcastTo in DB mode — global broadcast is a cross-org leak.**
- Durable logs: `JsonlLog<T>` (`src/jsonl-log.ts:33`) — ring authoritative, file best-effort,
  append never throws, one rotation generation. **Self-described lossy; not a durable queue.**
  Instances: transitions, push-taps, friction, operator-attention, compaction, plus separate
  automation.jsonl and audit.jsonl. No shared envelope exists across them.
- Emit points: land/merge finalization at `src/squad-manager.ts:3548-3566` (DoneProof + issue +
  branch in scope) and second block `:3950-3970`; gate summary appended as free text `system` at
  `:6873`; land-assessment hook (`src/land-assessment/hook.ts:48`, observe-only, fire-and-forget,
  flag `OMP_SQUAD_LAND_ASSESSMENT`, records LandAttemptEvents month-sharded); validator verdict
  `ValidationRecord` (`src/types.ts:448-467`) read by land BEFORE merge; done-proof
  (`src/done-proof.ts:16-27`).
- Peer messages: `deliverPeerMessage` (`src/squad-manager.ts:7197-7226`) — advisory fenced append,
  agent budget 5/run, verbatim comment: durable push "needs an outbox, which is intentionally out
  of scope."
- Scope contracts: `requires/produces/owns/scopeSource` on IssueRef (`src/types.ts:228-234`) and
  DTO; enforcement is SPAWN-TIME ONLY (`requiresConflict` `src/ownership.ts:122` hard-throws for
  operator-sourced overlap → dependents cannot coexist with producers). **Nothing fires on land**
  — no notifyDependents anywhere. This is why the buzz-borrows round killed the outbox: recipient
  set structurally empty; replacement = landed-context block at dispatch-time prompt composition.
- Steer path: `ClientCommand` union (`src/types.ts:1572-1592`, no "steer" type — steer = `prompt`
  without clientTurnId); HTTP `POST /api/command` (`src/server.ts:3185-3219`) and WS both land in
  `applyCommand` (`src/squad-manager.ts:6944-7195`) — single RBAC chokepoint (agent-origin
  message-only allowlist; tier gate; audit). **No per-unit in-flight guard or prompt queue**; a
  prompt to a working agent goes straight through as mid-turn steer. Silent-drop hole: missing
  target = bare `return` (`:7020`); WS callers get no per-command response (buzz-borrows 04
  ack/nack via clientTurnId is the designed fix, unbuilt).
- Dispatch from UI: `POST /api/spawn` prompt-only smart-spawn (`src/schema/http-body.ts:398-406`;
  repo heuristic in smart-spawn.ts); full-spec `{type:"create"}` → `CreateAgentOptions`
  (`src/types.ts:1251+`) is never constructed by the webapp.
- Federation seam: `FederationBus` (`src/federation.ts:58-97`) with TeamMessage {from,text,ts},
  NullFederationBus default, TailnetFederationBus real; authority-stripping `remoteCommandActor`
  (`:337-340`) never copies role/origin off the wire.
- Tenancy: `ManagerRegistry` (`src/manager-registry.ts:65`) per-org SquadManager, per-org state
  dirs, `Actor.orgId`; file mode = single implicit manager.

## Fact C — prior design verdicts that BIND this round (buzz-borrows DESIGN.md, adversarial round 2026-07-21, 26 findings)

- Durable outbox: KILLED (structurally empty recipient set + JsonlLog lossy). Replacement:
  landed-context block at dispatch/steer prompt composition (concern 02 shape).
- Standalone event substrate / EVENT_KINDS registry: KILLED at one consumer — the surviving shape
  is an optional `TranscriptEntry.event?: {kind: string; payload: unknown}` field + kind constants
  with a payload shape + ≥1 reader per kind (concern 01 shape). NOTE hazard: `TranscriptEntry.kind`
  (closed 5-value) vs `event.kind` (open string) are different axes — document loudly.
- Steer ack/nack (concern 04): clientTurnId as ack correlation + dedupe; SquadEvent
  `{type:"command-ack", clientTurnId, ok, reason}` arm; nack reasons missing-target/denied/
  duplicate/spawn-failed; ack on driver acceptance. Daemon-side prerequisite for mention UX.
- Mention-as-dispatch (concern 05, spec-first): reply-routing is unresolved (no shared room
  existed then — the channel primitive in THIS design may resolve it properly); `@` trigger
  already bound to task mentions in Composer; original constraint "mention never spawns" was
  scoped to the steer-only world — Lars's layer-1 UX explicitly includes spawning agents from
  chat, and the webapp's SpawnProposalCard/ConfirmSheet is the precedent shape for a safe
  spawn-from-mention (propose → confirm card).
- Untrusted strings: every agent/user-chosen string in manager-authored blocks goes through
  neutralizeDelimiters + redact (fences escapable without it).
- Revocation/grants: reaper never reads grants; positive-evidence rows via manager.remove() only
  (PR #217 friendly-fire class). Any presence/membership feature must not add absence-inference
  kill paths.

## Open design questions for this round

1. **Which frontend hosts layer 1?** webapp (browser, daemon-served, multiplayer-reachable, typed
   cards + steer already CODE) vs glance-desktop (Tauri, t3-face look investment, hub-shell plan,
   IDE-as-mode for the programmer layer) vs shared core consumed by both. What happens to
   hub-shell H0–H7 — absorbed, superseded, or executed as-planned in desktop while webapp leads?
2. **The channel/room data model.** Transcripts are per-agent today. Channels hold multiple humans
   + multiple agents + cards projected from units. New primitive (org-scoped Room/Channel store)
   vs generalizing transcripts. Presence, human↔human messages, membership, RBAC (Actor model +
   commandTier exist). Multiplayer without rebuilding tenancy.
3. **Card currency.** `TranscriptEntry.event {kind,payload}` as the single card substrate for both
   unit rooms and channels? Kind taxonomy for: plan card, spawn proposal, gate verdict, land
   attempt/assessment/merge, token burn, design-revised, needs-you. Doors: how a card deep-links
   to a layer-2 surface (plan DAG editor, fleet economics, programmer view).
4. **Mention grammar.** @agent in channel: steer if resident, spawn-proposal card if not?
   Reply routing with a real shared room. Collision with task-mentions.
5. **Layer-2 surfaces: which exist at slice 1?** Plan-DAG viewer exists (plan flow diagram in
   TaskDetail), token burn exists partially (receipt/contextPct on roster; harness attribution
   ingesters). Programmer view ≈ WorkspaceCockpit/IntervenceView today. Slice must define the
   minimum door set, not build all depth surfaces.
6. **Sequencing.** Daemon-side invisible work (emits, ack/nack, channel store) can land now;
   render-side rides the foundation-loved gate. What is the Lars-visible first increment that
   proves the two-layer grammar? Does the ACP-bridge spike (glance behind buzz's relay) run first
   to calibrate the UX target?
7. **DIRECTION.md amendment.** Draft language for Lars's review: buzz-shaped workspace as root,
   t3code repositioned as the programmer lens (its thread grammar + card craft absorbed into
   layer 1), terax law generalized (every expert surface is a mode), multiplayer scope.

## Binding directives from Lars (2026-07-22, mid-design-round — these override draft/red-team suggestions where they conflict)

1. **Scope: do it all — a fully featured application.** Rejects the draft's R1 mitigation
   (hard-capping slice 1 to one channel / one card kind / stub presence). The deliverable is the
   full buzz-shaped layer 1 — channels, threads/replies, presence, membership, search-grade
   history — plus the layer-2 doors, not a thin demonstrative slice. Red team B's "the fix is a
   swap, not more scope" is overridden on SCOPE; its structural findings (root route owning the
   viewport, control-plane verb in the room, kind-with-reader discipline, dead-door design,
   durable store for human messages, return-emit closing the loop) remain in force — they are
   correctness/shape findings, not scope caps, and a fully featured app satisfies several of
   them naturally (every kind ships with its door; membership/presence are no longer
   speculative freight but mandated features).
2. **glance-desktop is not used at all and does not work.** Resolves the designer's uncertainty
   and red team concerns about pausing it: supersession costs nothing — there are no users and
   no working product to freeze. hub-shell H0-H7 supersession + t3-face craft-harvest-as-
   learnings proceeds without a morale/product-cost caveat. The love-gate protocol from t3-face
   13 is re-targeted at the webapp room (red team B F2/F11 line).

Implication the arbiter must resolve: "do it all" and "foundation-loved-first" compose as
build the whole application with internal ordering — the love gate applies to the full room
experience (cold-boot first frame, rail, timeline, composer, doors), not to a single card demo;
daemon-side work is unthrottled; nothing is deferred to imaginary later phases, but landing
order still respects dependency + reviewability discipline.

## Phase 0 note

WIP snapshot 2026-07-22: scanner reports 1384 plans with open work / 4806 open concerns (counts
inflated by .claude/worktrees copies of the plans tree; real main-checkout pile dominated by
meta-autonomous-fleet 37 open, land-assessment + phase0-sandbox-hardening 11 each with fog, 118
hitl). Proceeded under the supersede framing: this plan folds in/supersedes plans/buzz-borrows
(unlanded, branch worktree-research-buzz) and will absorb/re-scope hub-shell per design decision.
