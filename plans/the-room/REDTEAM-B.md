# RED TEAM B — product & architecture findings on the-room DESIGN-DRAFT (Round 2)

Read both briefing docs, DIRECTION.md, plans/hub-shell/00-overview.md, plans/t3-face/13-acceptance-audit.md and 11-chrome-polish.md, plans/daily-driver/DESIGN.md, webapp/src/lib/intervene.ts, and grepped webapp/src for IntervenceView wiring and AssistantChat's spawn path. Most severe first.

NOTE (orchestrator): findings below predate Lars's binding directives (LANDSCAPE.md §Binding directives). Where a finding proposes CUTTING scope (F6, parts of F1's swap logic), the directive "do it all — fully featured application" overrides the cut but NOT the structural/correctness content of the finding.

## F1. CRITICAL — The Lars-visible increment is a read-only notification feed; it contains none of layer 1's actual UX and mostly reproduces a path that already ships

**EVIDENCE:** The ordered slice (steps 5–6) puts the visible increment at "one channel, gate-verdict cards, click opens IntervenceView" with the mention grammar (steer/spawn from chat) explicitly **after** it. So the first thing Lars touches has no control-plane verb — you cannot address an agent from it, and there is no second human to talk to. Meanwhile: "Spin up agents from chat" **already ships on main**: `webapp/src/components/AssistantChat.tsx:785-800` calls `/api/spawn` from the SpawnProposalCard → SpawnConfirmSheet flow. "Click into the programmer view" **already ships**: `webapp/src/components/WorkspaceCockpit.tsx:856,881,899,925` wires `onIntervene={openIntervene}` from four roster call sites. Slice 1's novelty over shipped code is only presentation: gate/land states re-rendered as a chat-shaped scroll. A developer-facing event feed wearing the vision's clothes; proves "a card can be a link" (cockpit already proves it), proves nothing about chat-as-control-plane, humans-and-agents-as-peers, or room-as-home.

**SUGGESTION:** The minimum increment that proves the grammar is *card-as-door AND chat-as-verb in one room*: room renders gate-verdict cards AND the room's composer can address an agent (steer w/ ack, or the SpawnProposal flow relocated into the room). A channel you cannot type into is not a chat workspace.

## F2. CRITICAL — "Wired into the existing shell, no shell rewrite" repeats the 2026-07-18 miss in mirror image and contradicts DIRECTION.md's standing shell law; the draft adopts hub-shell's thesis while rejecting its method

**EVIDENCE:** DIRECTION.md:13-16 standing law: "The app's DEFAULT shell IS t3code's two-pane thread client… the t3 experience is the whole app." The current webapp shell is the opposite shape — WorkbenchPane view-switcher nav rail + WorkspaceCockpit dashboard + AssistantChat right-docked side panel. DIRECTION.md:18-22 records exactly why this pattern fails: t3-face reskinned *within* the wrong frame; Lars: "doesn't look or feel like t3code at all." A channel mounted as another panel inside a workbench frame is the same defect with polarity flipped: last time chat-shaped content inside an IDE frame; this time inside a dashboard frame. It will feel like "another panel," not like buzz/Slack — the draft's own Approach admits the shell is untouched. The supersession is incoherent: it absorbs hub-shell's thesis ("chat as root, expert surfaces as modes") while discarding its method — hub-shell H0 ("two stacked shells, hub default," SERIALIZED because "everything rebases onto its App.tsx") *is* the load-bearing move; H1–H7 are decoration. The draft supersedes the plan and skips its only structural step. And no webapp-equivalent of the t3-face-13 love gate is defined anywhere.

**SUGGESTION:** The unconsidered sharper option: **HubShell-in-webapp** — a new root route inside webapp that owns the whole viewport (channel rail | conversation + hub composer), today's workbench views demoted to layer-2 modes/routes behind it. This is hub-shell H0 retargeted at the repo the draft chose; reuses everything the draft wants (typed cards, Composer, steer path, tenancy); makes the visible increment shaped like the product instead of a panel; gives delete-not-port a real mechanism (old views only reachable through doors). Add a webapp acceptance gate analogous to t3-face 13 (Lars's reaction to the room's cold-boot first frame) as the exit criterion. H0's own sizing was "M."

## F3. SIGNIFICANT — The DIRECTION amendment hardens an extrapolation into law: "a card is the only way in / no standalone nav path" is stronger than what Lars said, and wrong for the programmer persona

**EVIDENCE:** LANDSCAPE.md records the invariant as extrapolated ("never the home screen"). The amendment upgrades it to "no standalone nav path… bypasses the room" / "a card is the *only* way in." Different claims. "Never the home screen" bans layer 2 as default frame; it does not ban standing navigation. Cards decay down a scroll; a rail is a live projection of current state. t3code's own grammar — canonized by DIRECTION.md — is a *threads rail*: permanent nav beside the conversation. Under the amendment as written, the programmer persona (= Lars, the only user) must scroll a channel hunting for the latest gate-verdict card to reach the programmer view — strictly worse than the current one-click roster, violating "legible at a glance."

**SUGGESTION:** Weaken to what Lars said: layer 2 is never the home screen; every layer-2 *event* projects a card into the room; the room's rail (channels + active work) is a legitimate standing entrance. Flag the exclusivity clause to Lars as an open question rather than baking it as settled.

## F4. SIGNIFICANT — Dead-door problem: the flagship door's most common long-run state is a target that no longer exists

**EVIDENCE:** Cards are immutable/pinned; doors "re-query live data on open." But IntervenceView derives entirely from a live AgentDTO — `whyStopped(agent: Pick<AgentDTO,…>)` (webapp/src/lib/intervene.ts:24) — and units are removed from the roster after land. A channel is explicitly the surface that *outlives units* (Decision 2's own rationale). Steady state of an org channel: gate-verdict cards whose `{unitId}` refs resolve to nothing; any card older than a unit's lifetime opens a broken door. R2 covers door *latency* only, never door *lifetime*; no archival/historical read path designed.

**SUGGESTION:** Design the dead-ref path before increment 5 is done: (a) door renders from pinned `face` + persisted transcript/validation record when the live agent is gone (degraded-but-honest historical mode), or (b) gate-verdict payloads carry enough proof material (ValidationRecord, src/types.ts:448-467) to render the verdict without a live agent. Test the door against a landed-and-removed unit, not just a running one.

## F5. SIGNIFICANT — "Layer 1 is the complete projection of the system" is a law backed by a store that drops data by design

**EVIDENCE:** Amendment enshrines "the room stays the complete projection of system state." Chosen backing: JsonlLog-per-org, self-described lossy — ring authoritative, file best-effort, one rotation generation. Existing instances are bounded by unit/process lifecycles; a channel is unbounded org history. The draft notices the sizing problem (Uncertainties) but never connects it to the law it wrote: a complete projection stored in a lossy ring is a contradiction in the design's own terms.

**SUGGESTION:** (a) weaken the law to "complete *live* projection; history best-effort," stated for Lars to ratify; or (b) give channels a real store — DB mode has a database and per-org tenancy; a channel table in DB mode with JsonlLog as file-mode fallback is consistent with existing architecture.

## F6. SIGNIFICANT — Multiplayer scope isn't honest about the single-user present: membership + presence + human↔human messages are speculative freight in step 1
[SCOPE portion OVERRIDDEN by Lars's do-it-all directive; identity/enforcement content still binding]

**EVIDENCE:** Exactly one human user today. plans/daily-driver/DESIGN.md records "Per-viewer machinery has no principal in file mode (single user)." Of the multiplayer bundle, the load-bearing piece for the grammar is *a channel not bound to a unit*. Membership/visibility is precisely the feature class the binding revocation verdict warns about (no absence-inference kill paths).

**SUGGESTION (as amended by directive):** Multiplayer ships, but built on real substrate: per-human identity at the socket (red team A C2), per-channel fan-out enforcement (A S1), and membership semantics that the transport actually enforces — not decoration.

## F7. SIGNIFICANT — The 9-kind taxonomy with one reader violates the binding concern-01 verdict the draft claims to follow

**EVIDENCE:** Binding verdict: kind constants with payload shape **+ ≥1 reader per kind** — the condition that killed the standalone registry. Step 2 defines eight kinds "not all wired to a door yet": the speculative-registry pattern reintroduced under the same design's flag.

**SUGGESTION (as amended by directive):** With do-it-all scope, every kind ships WITH its reader/door in the program; the discipline becomes "no kind lands before its reader" as a landing-order rule rather than a scope cut.

## F8. SIGNIFICANT — The slice does nothing for the daily-driver bottleneck it queues in front of

**EVIDENCE:** The daily-driver program is the standing answer to "glance loses its own builder to plain Claude Code"; its arbitrated entry-surface decision is *terminal-first* ("The target user lives in terminals," plans/daily-driver/DESIGN.md). Slice 1's payoff is a browser feed of cards for states the cockpit and push lane already surface. Nothing moves an adoption counter or removes a friction-ledger item; "daily driver" appears nowhere in the draft.

**SUGGESTION:** (a) make the room serve the driver: needs-you-grade cards ride the existing push latch; `glance here` threads appear in the room's rail so terminal sessions and the room converge; or (b) state explicitly that this phase serves a future audience and ask Lars to re-sequence vs daily-driver — a plan-level call the human contract reserves for him; the draft decides it silently.

## F9. MINOR — Slice 1 tests only half the grammar: no action-in-door → card-back-to-room

**EVIDENCE:** Second invariant: "layer 2 never happens silently." IntervenceView's primary actions include line-comment→steer, yet no step emits anything back into the channel when a door action is taken. Door-in proven, return edge skipped.

**SUGGESTION:** A steer issued from IntervenceView projects a card into the channel. One event, closes the loop, makes the demo prove the actual invariant.

## F10. MINOR — Card→channel routing is undesigned; a single org channel is the attention lane's noisy twin

**EVIDENCE:** Step 4: "projected into the relevant channel(s)" — no rule defines *relevant*. With one channel it degenerates to an org-wide firehose of every unit's gate verdicts, duplicating (and out-shouting) the needs-you/attention lane — and "a Needs you lane with more than a couple of items… is a bug" (DIRECTION.md:35-36).

**SUGGESTION:** Name the routing rule explicitly; say how room cards relate to the attention lane (same events, different projection?) so the two attention surfaces don't diverge.

## F11. MINOR — "Run t3-face 13 as a craft-harvest review" is incoherent with 13 as written

**EVIDENCE:** 13 declares `BLOCKED_BY: 07,08,09,10,11,12` — including 12, which the draft pauses — and its protocol is a falsifiable *desktop* acceptance audit. None of it answers "what from this reskin gets adopted into webapp's card renderers."

**SUGGESTION:** Two separate acts: (i) formally close/park 13 with its blockers (Lars sign-off, same as hub-shell), (ii) a new lightweight craft-harvest pass (taste ≥ 7 reviewer over the t3-face diffs, output = adoption list for webapp). Don't launder one through the other.

## F12. MINOR — Mention "steer-if-resident" injects mid-turn prompts into working agents with no guard; and the Tauri rejection rationale is wrong even though the conclusion is defensible

**EVIDENCE:** (a) No per-unit in-flight guard; a buzz-persona user @-mentions an agent to get its attention; under this design that casually injects text into a working agent's live context. Ack/nack makes the outcome *visible*, not *safe*. (b) Decision 1 rejects desktop partly because "a Tauri app is architecturally single-user-native" — false as stated: the daemon holds tenancy; a Tauri client of the same daemon is exactly as multiplayer-capable as a browser tab. The real argument (zero-install, URL-shareable delivery) stands alone.

**SUGGESTION:** (a) For `working` agents, mention → queue-or-confirm (mirroring SpawnConfirmSheet's propose→confirm precedent) rather than raw mid-turn steer; or scope mentions to idle/input agents initially. (b) Strike the "architecturally single-user-native" sentence; keep the delivery argument.

## Summary for the arbiter

The two criticals compound into one product-level verdict: as drafted, slice 1 ships daemon plumbing (largely sound) plus a visible increment that is neither the vision (no control-plane verb, F1) nor a lovable foundation (wrong shell frame, the exact rejected pattern, F2). [Original swap-not-scope recommendation superseded by Lars's do-it-all directive — the structural moves stand: clean root route owning the viewport, composer verb in the room, return-emit, love gate.] The amendment needs three edits before Lars sees it: soften "only way in" (F3), reconcile "complete projection" with the store or the store with the law (F5), and surface the daily-driver sequencing call explicitly instead of deciding it by omission (F8).
