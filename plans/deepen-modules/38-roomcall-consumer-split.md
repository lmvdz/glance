# roomCall.ts — split by the consumer table, not into a class
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: webapp/src/lib/voice/roomCall.ts (1,064 lines, 63 exports — 21 types, 8 consts, 34 functions — 11 banner sections, 13 production importers in DISJOINT slices)
MODE: afk

## Goal
Round-2's "VoiceCallSession class" framing is REFUTED: there is no session state machine here —
every export is a pure (DTO, now) → copy/model function; the stateful session lives in
VoiceCallContext/useRoomCall. The file is a presentation library that outgrew its name and has
already de-facto split (the importer table shows disjoint slices). Honest seam: file split
along the existing banners, driven by consumers — voice/callChrome.ts (:105-273, phase/banner/
terminal/retention), voice/decisionDoor.ts (:338-548), voice/artifactsIndex.ts (:709-843),
voice/paneStack.ts (:845-918, HubShell only — coordinates with concern 37), voice/
threadStatus.ts (:595-707). registerPresentation (:78) finishes its move to channelTimeline.ts
where its type already lives. Pure moves, re-exports for one release, then callers updated.
NOTE: IDLE_HANGUP_MS/idlePolicyLine/IDLE_WARNING_MS (:278-299) currently have no live consumer
once the dead HUD is excluded — their disposition belongs to concern 36, don't sweep them here.

## Provenance
Round-3 review, webapp agent item 1; supersedes the round-2 "VoiceCallSession class" candidate.
