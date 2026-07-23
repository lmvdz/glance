# the-room — the two-layer product: buzz-shaped chat workspace root, glance/t3code depth behind doors

Design: [DESIGN.md](DESIGN.md) (adversarial round: 1 designer, 2 red teams — 25 findings, arbiter).
Landscape + binding directives: [LANDSCAPE.md](LANDSCAPE.md). Full scope per Lars's do-it-all
directive; ordering, not deferral, carries the discipline.

## Outcome

- The app opens into a collaborative chat workspace: channels where humans and agents are peers;
  agents are spun up and steered from the composer; every system fact arrives as a manager-authored
  proof card; every card is a door into glance's plan/economics depth or t3code's programmer view;
  no depth action happens silently. Multiplayer (DB mode) on real identity with enforced visibility.
- Room leads; daily-driver converges into it (Lars, design gate 2026-07-22).

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 channel-store](01-channel-store.md) | Durable org-scoped channels; human messages are irreplaceable (A-C1) | architectural | src/channels.ts (new), src/dal/storage.ts, db schema, src/types.ts, src/server.ts |
| [02 ws-identity](02-ws-identity.md) | Multiplayer needs per-human identity at the socket (A-C2) | architectural | src/server.ts (upgrade, SocketData, actorForSocket) |
| [03 command-ack](03-command-ack.md) | No silently dropped steers; mention prerequisite (supersedes buzz-borrows 04) | mechanical | src/squad-manager.ts, src/types.ts, webapp/src/lib/agent-control.ts, dto |
| [04 unit-event-emits](04-unit-event-emits.md) | Verdicts/lands become typed transcript events (supersedes buzz-borrows 01) | architectural | src/types.ts, src/squad-manager.ts, src/transcript-event-kinds.ts (new), dto |
| [05 projection-routing](05-projection-routing.md) | Unit events reach the right channel; #fleet default; pointer-cards (A-S5/B-F10) | architectural | src/squad-manager.ts, src/channels.ts, src/types.ts (CreateAgentOptions) |
| [06 landed-context-dispatch](06-landed-context-dispatch.md) | Dispatched units know what dependencies produced (buzz-borrows 02, carried over) | architectural | src/squad-manager.ts (prompt assembly), src/land-assessment/store.ts |
| [07 hubshell-root](07-hubshell-root.md) | The room owns the viewport; workbench demoted to modes (B-F2) — SERIALIZED | architectural | webapp/src/App.tsx, webapp/src/components/hub/* (new), hash router |
| [08 channel-timeline](08-channel-timeline.md) | Typed-card timeline bound to channel entries + cursor resync | architectural | webapp/src/components/hub/*, webapp/src/hooks, ws/useSquad |
| [09 room-messaging](09-room-messaging.md) | Humans talk to humans; presence renders | architectural | webapp hub components, src/server.ts (channel post), src/channels.ts |
| [10 mention-grammar](10-mention-grammar.md) | @agent = steer/spawn from chat, safely (supersedes buzz-borrows 05) | architectural | webapp Composer/useTriggerMenu/sendCore, src/squad-manager.ts |
| [11 replies-search](11-replies-search.md) | Threads (replyToId) + channel search over durable rows | mechanical | webapp hub components, src/server.ts, src/channels.ts |
| [12 needs-you-door](12-needs-you-door.md) | Flagship door: needs-you card → IntervenceView, live-by-construction (A-C3a) | architectural | kinds, webapp hub cards, IntervenceView hash route |
| [13 gate-verdict-door](13-gate-verdict-door.md) | GateVerdictCard + historical proof endpoint + post-mortem mode (A-C3b/S6, B-F4) | architectural | src/server.ts (proof endpoint), webapp GateVerdictCard (new) |
| [14 plan-card-door](14-plan-card-door.md) | plan-card → plan-DAG editor door | mechanical | kinds, webapp cards, TaskDetail route |
| [15 token-burn-door](15-token-burn-door.md) | token-burn-snapshot → fleet economics door | mechanical | kinds, webapp cards, economics surface |
| [16 land-lifecycle-cards](16-land-lifecycle-cards.md) | land-attempt/assessment/merge cards | mechanical | kinds, webapp cards |
| [17 return-emit](17-return-emit.md) | Door actions emit cards back — invariant both directions (B-F9) | mechanical | door surfaces, src/channels.ts |
| [18 membership-fanout](18-membership-fanout.md) | Membership WITH per-channel socket-filter enforcement + leak tests (A-S1) | architectural | src/server.ts (fan-out), src/channels.ts, db schema |
| [19 multiplayer-polish](19-multiplayer-polish.md) | Typing, read cursors, concurrent-steer visibility, two-browser smoke | mechanical | webapp hub, src/server.ts |
| [20 acp-spike](20-acp-spike.md) | Feel buzz's layer-1 UX via buzz-acp → glance ACP; calibration only | research | scratch rig only; no product code |
| [21 craft-harvest](21-craft-harvest.md) | t3-face visual work → adoption list for room card craft (B-F11) | research | plans output only |
| [22 daily-driver-convergence](22-daily-driver-convergence.md) | glance-here threads in rail; needs-you cards ride push latch (B-F8) | mechanical | webapp rail, src/server.ts push path |
| [23 love-gate](23-love-gate.md) | Lars's acceptance run on the whole room (t3-face-13 protocol re-targeted) | research | scratch-daemon + agent-browser rig |
| [24 supersessions-amendment](24-supersessions-amendment.md) | DIRECTION.md amendment; close hub-shell/t3-face-13; buzz-borrows disposition | mechanical | DIRECTION.md, plans/hub-shell, plans/t3-face, plans/buzz-borrows |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 0a | 01, 02, 03, 04, 06 | Wave-0 daemon substrate; independent tracks, distinct file regions (01/02 both touch server.ts — sequential merge) |
| 0b | 05 | Needs 01 (store) + 04 (kinds) |
| 1 | 07 then 08 | Shell root is SERIALIZED (everything rebases onto App.tsx); timeline binds to it |
| 2 | 09, 10, 11 | Control-plane verbs — must land before the love gate (B-F1); 10 needs 03; all need 07/08 |
| 3 | 12, 13, 14, 15, 16, then 17 | Doors, kind+reader units; 17 needs the first door |
| 4 | 18, 19 | Multiplayer hardening; 18 is one landing unit with leak tests |
| parallel | 20, 21, 24 | Anytime; 22 after 05+07 |
| gate | 23 | After waves 1–3 land and org-public path works |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 05 | 01, 04 | `ls src/channels.ts` exists; `grep -n "event?" src/types.ts` shows TranscriptEntry.event |
| 07 | 01 | channel GET endpoint answers in scratch daemon |
| 08 | 01, 07 | hub root route renders; `grep -rn "HubShell" webapp/src/App.tsx` |
| 09 | 01, 02, 07 | SocketData carries userId (`grep -n "userId" src/server.ts`) |
| 10 | 03, 08 | `grep -n "command-ack" src/types.ts` hits |
| 11 | 01, 08 | channel rows queryable (search endpoint 200s) |
| 12 | 04, 05, 08 | needs-you kind constant exists with reader wired |
| 13 | 04, 05, 08 | ValidationRecord emit visible in a scratch-daemon land |
| 14, 15, 16 | 05, 08 | projection routing lands cards in #fleet |
| 17 | 12 | first door merged |
| 18 | 01, 02 | identity + store landed |
| 19 | 09, 18 | membership filter enforced (leak test green) |
| 22 | 05, 07 | rail exists; projection routing live |
| 23 | 07–17 | waves 1–3 STATUS done |

## Not yet specified

- (none)

## Out of scope

- Nostr/buzz-relay adoption — binding research verdict; ACP spike is calibration only — see DESIGN.md
- Durable agent-to-agent outbox — killed twice (buzz-borrows round; recipient set structurally empty) — see LANDSCAPE Fact C
- Cross-org channel federation — FederationBus authority model is its own design; channels are per-org
- Per-human identity in file mode — Lars ratified DB-only multiplayer at the design gate
- buzz-borrows 03 (friction distillation), 06 (agent grants), 07 (orch health report) — remain with plans/buzz-borrows; not absorbed here (concern 24 records the disposition)
- Porting old webapp panels into the shell wholesale — delete-not-port; surfaces earn doors

## Decisions so far
- Wave 0 landed 2026-07-23 as one merge train (PR #225) after the catastrophe recovery — 6/24 concerns done (01/03/04/06/21/24); 02 resuming with cross-lineage gate; 05 dispatched; see memory omp-squad-wave0-catastrophe-layers for the 6-layer post-mortem

- [DESIGN.md](DESIGN.md) — arbitrated final: HubShell root, durability split, WS identity, manager-only proof cards, needs-you flagship door + historical gate-verdict mode, guarded mention grammar, projection routing, kind-with-reader landing order
- Design gate (Lars, 2026-07-22) — room leads daily-driver; rail-entrance softening ratified; DB-only multiplayer ratified

## Notes

- Phase 0 WIP snapshot: proceeded under supersede framing over a large open pile (see LANDSCAPE §Phase 0); this plan supersedes plans/buzz-borrows 01/02/04/05 and plans/hub-shell H0–H7; parks t3-face 12/13.
- Lars's binding directives (scope: do it all; glance-desktop dead) recorded in LANDSCAPE.md and honored in DESIGN.md.
- Not filed to Plane yet — offer /plan-to-plane at decompose gate.
