# the-room — DRAFT design (Round 1, Designer output — under adversarial review, NOT final)

## Approach

Ship layer 1 as an evolution of the webapp already on main, not a new shell: the chat workspace is a genuinely new primitive (org-scoped channels, human↔human messages, presence) but its *rendering grammar* — typed cards, not bubbles — already exists and is proven code (`TranscriptTimeline.tsx`, `GateWidget.tsx`, `SpawnProposalCard`). The daemon-side work (channel store, event-kind taxonomy, ack/nack) can and should land immediately since none of it touches a render surface Lars has to bless; the Lars-visible increment is deliberately the smallest possible proof of "card is a door" — one channel, one card kind, one door — wired into the existing shell rather than a new nav rewrite. glance-desktop's hub-shell plan (zero code) is superseded outright by this; its t3-face reskin (real shipped work) survives as a craft/visual reference to harvest into webapp, not as the delivery vehicle for layer 1.

## Decisions

### 1. Which frontend hosts layer 1?

**Choice: webapp leads. hub-shell H0–H7 superseded, not executed. glance-desktop repositioned as a future power-user/programmer-layer shell, frozen for now.**

Alternatives considered:
- *glance-desktop (Tauri) leads.* Rejected. "Typical users" = multiplayer humans in shared org channels; that wants zero-install, URL-shareable, browser-reachable delivery. A Tauri app is architecturally single-user-native (one install, one session) and multiplayer-over-Tauri is a heavier lift than multiplayer-over-a-daemon-served-web-app that already has orgs/auth/DB-mode tenancy (`ManagerRegistry`). hub-shell's own plan nests the chat-as-root idea *inside the IDE frame* — it's solving "chat inside a desktop app," not "chat as the product."
- *Shared headless core consumed by both.* Attractive in principle (one channel/event logic, two renderers) but premature — an abstraction bought before there are two live consumers with genuinely divergent rendering needs. Defer until glance-desktop actually needs the same channel logic for its programmer-view mode; extract then from two real call sites.
- *webapp leads (chosen).* It already has the typed-card rendering grammar, steer path, and multiplayer-capable tenancy as CODE. The gap is channels/presence/human-messages, not the rendering substrate.

hub-shell H0–H7 (thread-client-as-root, IDE-as-mode) is **superseded**: its core idea — chat as root, expert surfaces as modes — is exactly this design's layer 1/layer 2 split, just re-targeted at webapp. Since hub-shell has zero code, nothing is thrown away; close its concern docs with a pointer to the-room rather than executing. t3-face (concerns 01–10 done, 11 in flight, 12 deferred, 13 = Lars's acceptance gate) is real shipped visual work and is **not** wasted: it becomes the design-language input for the programmer-view mode inside webapp (colors, card craft, terax-frame conventions), ported as *learnings*, not code (respects delete-not-port). Concretely: finish 11 and run 13 as a craft-harvest review ("what from this reskin gets adopted into webapp's card renderers"), then pause concern 12 and all of hub-shell — no new glance-desktop-only surface area until layer 1 in webapp is loved. This is a scope reversal for two active plans and needs Lars's explicit sign-off (see DIRECTION.md amendment and Risk R6).

### 2. The channel/room data model

**Choice: new primitive — an org-scoped `ChannelStore`, separate from per-agent `TranscriptEntry`, whose entries reuse the same envelope shape (`kind`/`text`/`ts`/`event`/`status`) so the existing typed-card renderers can bind to either.**

Alternatives considered:
- *Generalize `TranscriptEntry` itself to be multi-owner.* Rejected. `TranscriptEntry`'s lifecycle is bound to one manager's per-agent seq stream, and settle-on-exit (`settleRunningEntries`) mutates `running` entries in place keyed to *that agent's process exiting*. A channel has no analogous process — it outlives any single agent or unit. Forcing membership/presence onto that shape means either inventing a fake "process" for a channel (contrived) or quietly relaxing the born-settled/append-only invariant for a subset of entries (exactly the class of bug PR #216 fixed). Two different lifecycles, one struct — bad idea.
- *Borrow buzz-relay's store shape (Postgres/Redis).* Already rejected by binding verdict — second platform, prototype maturity, org-confinement mismatch. Borrow the *shapes* (channel, membership, presence as concepts), not the store.
- *New primitive (chosen).* Gives channels their own append point, own actor/membership model (genuinely new — RBAC today is per-command via `Actor`/`commandTier`, not per-channel-membership), and its own store lifecycle, while keeping entry *rendering* uniform by reusing the envelope. Store backing: `JsonlLog`-per-org, same self-described-lossy discipline as everything else (ring authoritative, file best-effort) — no new durability promise invented. Cards projected from a unit into a channel are **pointers** (`{unitId, entryId}` refs), never copies, so the channel entry doesn't duplicate or need to stay in sync with the unit transcript's own mutations. Fan-out is per-org `broadcastTo` (binding tenancy rule), never global `broadcast`.

### 3. Card currency

**Choice: `TranscriptEntry.event {kind, payload}` is the single card substrate for both unit rooms and channels, as the binding verdict already fixes. Payload is a pointer + a small at-emission snapshot for the card face, not a full copy of live state; doors re-query live data on open.**

Kind taxonomy for slice 1 and near-follow: `plan-card`, `spawn-proposal`, `gate-verdict`, `land-attempt`, `land-assessment`, `land-merge`, `token-burn-snapshot`, `design-revised`, `needs-you`. Each kind gets ≥1 reader per the binding shape (concern 01) — the reader is exactly the door.

Doors: a card's `event.payload` carries `{refs: {unitId, entryId?, planId?, landId?}, doorSurface: "plan-dag" | "fleet-economics" | "programmer-view", face: {…minimal display fields captured at emission}}`. Clicking a card opens the door surface as an overlay/route inside the current shell — never a new app window — and the door fetches current state by `refs`, not by trusting `face`. A card is a proof pinned at time-of-emission (immutable, append-only) but the underlying plan/DAG/gate can have moved by the time someone clicks it days later; rendering only the pinned snapshot would silently lie. Alternative — embedding full-fidelity render data in the payload so doors never re-fetch — rejected: it either goes stale (shown as fresh) or forces re-emitting cards on every state change, which is scope creep into a live-sync problem slice 1 doesn't need.

### 4. Mention grammar

**Choice: `@agent` in a channel steers if the agent is resident (attached to a unit already represented in that channel), else produces a spawn-proposal card (propose → confirm), using the existing `SpawnProposalCard`/`SpawnConfirmSheet` precedent. Extend the existing Composer mention picker to list agents alongside issues rather than introducing a second trigger character.**

The binding verdict for concern 05 says the original "mention never spawns" constraint was scoped to a steer-only world that no longer applies — Lars's layer-1 UX wants spawn-from-chat. Collision with task-mentions (already bound to `@`): rather than reserve a second sigil (churn on an existing keybinding) or silently overload `@` with ambiguous resolution, extend the one picker to show two sectioned result groups (agents, issues) under the same trigger — least surprise, no new keybinding, and issue identifiers (`DAGON-123`-shaped) don't collide textually with agent names/ids in practice.

Reply routing: a `replyToId` field on the channel entry, distinct from `clientTurnId` (which stays reserved for ack-correlation of the sender's own optimistic entry, per the concern-04 shape) — NOT verified against any existing thread-reply UI convention in webapp; flagged in Uncertainties.

### 5. Layer-2 surfaces at slice 1

**Choice: wire exactly one door end-to-end for slice 1 — gate-verdict card → IntervenceView (the programmer-layer step-in screen) — rather than partially wiring all three (plan-DAG, economics, programmer view).**

IntervenceView already exists as a real surface (why-stopped, diff-as-spine, line-comment→steer) and a gate-verdict card is the single highest-leverage proof of "cards are proofs, not agent self-reports" — the differentiator Lars named explicitly. Plan-DAG (plan flow diagram in TaskDetail exists) and fleet economics (receipt/contextPct partially exists) are real doors too, but wiring three half-finished doors risks a feature pile instead of one thing Lars can love completely. They follow in slice 2/3 using the same door convention — no new design work, just more kinds.

### 6. Sequencing

**Choice: daemon-side work (channel store, event-kind taxonomy, ack/nack) lands now, unconditionally. The Lars-visible first increment is: one channel, one card kind (gate-verdict), one door (IntervenceView), rendered inside the current webapp shell — no shell rewrite. The ACP-bridge spike runs in parallel, time-boxed, non-blocking; discarded as code, kept only as UX notes.**

Invisible daemon work doesn't need Lars's foundation-love gate. The render-side increment is scoped as small as it can be while still proving the actual grammar (card → door → real depth surface, not a mock), because a foundation Lars can love is one true thing, not three demo-quality things. The ACP-bridge spike must not gate the increment; if still running when the increment is ready, ship on the current shell and fold spike learnings into slice 2.

### 7. DIRECTION.md amendment

Draft below.

## First Vertical Slice (ordered)

1. **`ChannelStore` (daemon, invisible).** Org-scoped, `JsonlLog`-backed, per-org `broadcastTo` wiring, entries reusing the `TranscriptEntry` envelope shape plus `event`. Membership model (who can post/see) and a presence stub (online/offline only, no typing indicators). Tests: append-only, no channel entry ever created with `status: "running"` (guards the settle-on-exit invariant boundary).
2. **Event-kind taxonomy + readers (daemon, invisible).** `gate-verdict` kind first (needed for the flagship door), constants + payload shape + the IntervenceView reader. Others (`plan-card`, `land-*`, `token-burn-snapshot`, `spawn-proposal`, `needs-you`, `design-revised`) defined but not all wired to a door yet.
3. **Ack/nack (daemon, invisible).** `clientTurnId`-correlated `{type:"command-ack", clientTurnId, ok, reason}` per concern-04's binding shape — prerequisite for any mention-driven UX to feel non-silent.
4. **Card projection: unit → channel (daemon, invisible).** Land/gate events already emitted by `SquadManager` get projected into the relevant channel(s) as pointer-cards. Neutralize+redact discipline applied at projection (untrusted agent/unit text going into a channel other humans read).
5. **Lars-visible increment: one channel, gate-verdict cards render as typed cards in webapp's existing `TranscriptTimeline`-style renderer, click opens IntervenceView.** This is the proof of "cards are doors."
6. **Mention grammar v1: `@agent` steer-if-resident / spawn-proposal-if-not, picker extended.** Ships once ack/nack (step 3) is live — a mention-driven spawn needs the ack path to not silently drop.
7. **Second and third doors (plan-DAG, token-burn) using the proven convention.** Fast-follow, not gating slice 1's "done."

## What is NOT in slice 1

- Typing indicators / rich presence (stubbed online/offline only).
- Threaded replies beyond a flat `replyToId` (no nested thread UI).
- Reactions, read receipts, channel search.
- Any hub-shell execution or new glance-desktop feature work (concern 12 and all H0–H7 paused pending Lars's sign-off on the amendment).
- A durable outbox of any kind — still killed; channel cards are the notification mechanism, sourced from the same landed-context-at-dispatch design as buzz-borrows concern 02.
- A standalone event registry/service — still killed; `event.kind` stays an open string on the existing envelope, per concern 01.
- Full economics/DAG doors (exist partially, deferred to fast-follow per Decision 5).
- Shared headless core package for webapp/glance-desktop (deferred until two live consumers actually need it).
- Cross-org federation of channels (FederationBus authority-stripping gap out of scope; channels are per-org only, matching the binding tenancy rule).

## DIRECTION.md amendment draft (for Lars's review)

> ### Two-layer architecture (supersedes prior single-surface framing)
>
> The product is two layers. **Layer 1 is the room**: a buzz-shaped collaborative chat workspace — org-scoped channels where humans and agents are peers, browser-delivered, multiplayer by default. This is the home screen for typical users; they spin up agents from chat and never have to leave it.
>
> **Layer 2 is depth, entered from chat, never the front door.** glance's depth is plan/workflow structure — the DAG, fleet-wide economics, design revision. t3code's depth is the programmer's view — active/waiting agents, transcripts, diffs, steer. Every layer-2 surface is a *drill-in from a card*; there is no standalone nav path to it that bypasses the room.
>
> Two invariants govern the boundary: **cards are doors** (a card is the only way in), and **layer 2 never happens silently** — any action taken in a depth surface emits a card back into the room, so the room stays the complete projection of system state. Cards are proofs — gate verdicts, land assessments, done-proofs from the trust layer — never agent self-reports; this is the product's differentiation, not a UI style choice.
>
> **t3code is repositioned, not deprecated**: its thread grammar and card craft are absorbed into layer 1's rendering conventions; "t3code" names a *lens* (the programmer-layer mode), not a separate application. The terax visual-craft law generalizes: every expert surface — plan editor, economics view, programmer view — is a *mode* reached through a card, sharing one shell.
>
> **Multiplayer is in scope from the start**: multiple humans per org, in shared channels, alongside agents. This is new relative to today's single-operator-per-unit model and is the primary net-new primitive this phase builds.
>
> **glance-desktop** (Tauri, t3-face reskin) is not the delivery vehicle for layer 1; its visual work is harvested as design input, and further feature investment there is paused pending this room's foundation being loved.

## Risks

- **R1 (high) — channel-store scope creep.** "New primitive" is an invitation to rebuild Slack instead of shipping a thin slice. Mitigate by hard-capping slice 1 to one channel type, one card kind, stub presence, no threads/reactions. Evidence: track files/LOC touched per step; a channel-store PR that grows past a small, reviewable unit is the tell.
- **R2 (medium-high) — door latency.** Pointer-cards mean every door click re-queries live state; if the plan-DAG or economics endpoints are slow, "click card, wait" breaks the foundation Lars is supposed to love. Evidence: measure door-open latency in scratch-daemon for the IntervenceView door before calling increment 5 done.
- **R3 (medium) — mention-picker regression.** Extending the existing `@` picker to include agents risks breaking task-mention behavior in Composer. Evidence: run Composer's existing mention tests before/after.
- **R4 (medium) — settle-on-exit invariant leakage.** Channel entries authored by humans have no process to "settle on exit"; a copy-pasted append path could reintroduce the in-place-mutation bug class PR #216 fixed. Mitigate with an explicit test: no channel append ever sets `status: "running"`.
- **R5 (medium) — tenancy leak via a new fan-out path.** If channel WS fan-out is wired ad hoc instead of reusing per-org `registry.onEvent`/`broadcastTo` plumbing, it recreates the global-broadcast cross-org leak class. Evidence: grep the channel-store diff for any call to `broadcast(` (not `broadcastTo`) before merge.
- **R6 (low-medium) — desktop sunk-cost/morale.** Repositioning glance-desktop to "future power-user shell, paused" is a real scope reversal on two active plans (t3-face, hub-shell) and needs Lars's explicit blessing. Mitigate: the DIRECTION.md amendment surfaces this plainly before concern 12/hub-shell are formally paused.
- **R7 (low) — ACP-bridge spike scope creep.** A "spike to feel buzz's UX" can quietly grow into "build the relay alternative," which the binding verdict rejected. Mitigate: time-box, own plan doc, explicit non-goal line.

## Uncertainties (designer could not resolve from the landscape alone)

- **glance-desktop's actual usage today.** If it has active users, "pause new feature work" has a product cost this document can't quantify.
- **Presence fidelity required for slice 1.** Assumed online/offline stub; could be wrong in either direction.
- **Channel membership/RBAC mapping onto the existing auth model.** `Actor`/`commandTier` gate commands; how per-channel membership (who can see a channel) composes with that needs a deeper auth-model read.
- **Reply-routing/threading convention.** `replyToId` is an extrapolation, not verified against any existing webapp thread UI convention.
- **Whether existing typed-card components bind narrowly to unit-transcript context.** If `SpawnProposalCard`/`GateWidget` prop shapes assume a single-unit transcript, step 5 needs component surgery, not thin wiring.
- **JsonlLog sizing for a channel of unbounded lifetime.** Existing instances are bounded by process/unit lifecycle in practice; a channel outlives them across an org's whole history. Rotation/ring discipline may not hold for a much longer-lived log.
