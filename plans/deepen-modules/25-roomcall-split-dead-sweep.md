# roomCall.ts split + the dead-component sweep
STATUS: open
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
