# Spawn-proposal room path — wire it or delete it
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/components/hub/HubShell.tsx:369 (hand-minted local:spawn-proposal card), webapp/src/lib/channelTimeline.ts:17/:183/:258/:468 (DOOR_LABELS['local:spawn-proposal'] = 'Open the proposal' — unreachable: payload carries no href/doorSurface so no door renders), webapp/src/lib/spawnProposal.ts (detection half spawnProposalFor/:97 + 3 exports test-only), webapp/src/components/hub/SpawnConfirmSheet.tsx + SpawnStatusCard.tsx + SpawnProposalCard.tsx (~226 lines, zero importers), src/server.ts:2716 (/api/spawn — only caller is voice), src/transcript-event-kinds.ts:7 ("reserved: spawn-proposal" — daemon kind never minted)
MODE: interactive

## Goal
Dead end-to-end on the hub path, and dishonest while it stands: the card's own detail copy
claims "enters the existing /api/spawn flow" — false; its door label exists and cannot render;
the confirm sheet documents wiring that was never made. The CHAT proposal (separate
SpawnProposalCard with a working onPropose door) is live — two things share a name and one
works. PRODUCT GATE (needs-lars if hit): wire the hub card into the chat propose flow /
api/spawn (the components + prompt-builder + status card all exist — this is plumbing, not
building), or delete the hub trio + detection half + registry entries (~250 lines + 9 test
cases). Either resolves the quiet-default hazard: an interface promising an affordance the
module never implements. If wiring: the missing pieces are a doorSurface/href on the :369
payload and a confirm-flow mount; if deleting: LOCAL_CARD_KINDS loses its third member.

## Provenance
Round-3 review, both agents converged (daemon item 3, webapp item 8 + headline cascade);
carried from round-2 (codex Critical: inert room spawn-proposal flow).
