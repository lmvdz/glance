# roomCall.ts split + the dead-component sweep
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate (steps 1–3 pure moves)
TOUCHES: webapp/src/lib/voice/roomCall.ts (1,064 lines, 79 exports, ~12 concerns), VoiceCallHud.tsx (305 lines, ZERO importers), 9 more unreferenced components (~670 lines), VoiceCallContext.tsx (10 useState + 16 useRef + 7 useEffect)
MODE: afk

## Goal
Order of attack: (1) delete VoiceCallHud + its 4 sole-consumer exports + verify/delete the
other 9 dead components (StatePane, SpawnConfirmSheet, HeatGrid, JoinRequests, SpawnStatusCard,
AdoptCard, Callout, PanelShell, SpawnProposalCard); (2) lift the three NON-voice regions out of
lib/voice/ (cardRegister, paneStack, raw-room-event filter → channelTimeline); (3) split the
remainder along the consumer boundaries the import table draws (decisions/artifacts/phase/
surface). SEPARATE LATER PR: VoiceCallSession class behind VoiceCallContext — the RoomSession
shape (PR #318) applied to the voice stack.

## Provenance
Round-2 review, webapp agent, rank 3, Strong.

## Step 1 done (2026-08-12, round 3 iteration 12 — PR #379); steps 2-3 remain
The 10-component sweep landed (~1,300 lines incl. tests) with the strongest review round of the
queue: grok's forensic table + codex's request-changes converged on the SAME five feature
orphans, and the adjudication split them honestly — two were standing-surface STATUS gaps fixed
in this PR (retention mismatch now outranks all but a dead call in threadStatus with role=alert;
useRoomCallAudio's discarded error/retry state now feeds VoiceStatusRegion), and three are
pre-existing inert FLOWS queued for the review round with evidence (room spawn-proposal
card is doorless with no confirm and no /api/spawn caller; adoption has a live route + full
client bridge + zero UI; the D3 spawn lib halves in spawnProposal.ts are test-only). Replaced:
hud→RoomCallIconControls, StatePane→RoomFrame, JoinRequests→PeopleSurface. Safely dead: Callout,
PanelShell, HeatGrid (the magma tree was dropped by design — GRAPH-FOLD.md).
REMAINING SLICES: (2) delete the 8 orphaned hud-only roomCall helpers (browserAudio* RETAINED —
remounted by this PR's fix), lift the three non-voice regions out of lib/voice; (3) split
roomCall.ts along consumer boundaries; separate later PR: VoiceCallSession behind the context.

## Done (2026-08-12, round 3 iterations 12-13 — PR #379); step 3 carried to round 4
Steps 1 + 2 delivered: ~1,500 lines of dead code gone (10 components + 6 hud helpers + tests),
two LIVE status fixes shipped from the review rounds (retention-mismatch precedence with
role=alert; browser-audio error/retry remounted), the card-system regions re-homed into
channelTimeline (byte-identical moves, SHA-verified by codex; import direction now one-way),
and one policy near-miss caught by three independent signals (IDLE_HANGUP_MS is a cross-tree
policy mirror, restored; its sibling IDLE_WARNING_MS deleted as a default-mirror that would lie
under runtime overrides). CARRIED TO ROUND 4 as a named candidate, not silently dropped:
step 3 (the consumer-boundary split of the remaining ~800-line roomCall.ts + the PaneStack
parameterization — its mechanism is generic but its types are voice-workspace-bound) and the
separate-later-PR VoiceCallSession class. Also queued from this concern's reviews: the inert
spawn-proposal flow, the surfaceless adoption bridge, the idle-countdown display gap, and
VoiceCallContext's false 10-minute copy vs callHud's 3-minute cap.
