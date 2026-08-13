# SocketData + face shapes — contracts the tests re-invent
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: simple
TOUCHES: src/server.ts:378 (interface SocketData, NOT exported), tests/channel-membership-fanout.test.ts:12 (imports it anyway — tsc error surviving only under bun's type-stripping), src/coordinator.ts:37 (an UNRELATED interface SocketData), src/schema/channel-card.ts:161 NeedsYouFaceSchema, webapp/src/lib/channelTimeline.ts:26 PointerCardFace (hand-maintained superset), 49 inline face literals across tests/
MODE: afk

## Goal
Contract tightening, not extraction. (a) Export SocketData (or move it to a server-socket.ts
tests can legitimately import) and rename coordinator.ts's same-named stranger to
RelaySocketData — two SocketDatas in one daemon is a mis-import waiting to happen, and the
test's structural mirrors (DeliverSocket/DeliverHost/TranscriptEventHost) should compose the
real type. (b) Derive PointerCardFace from channel-card.ts's schema the way
TranscriptEventKind already derives from transcript-event-kinds.ts — the pattern is proven
in-repo, it just wasn't applied to faces. The dto-conformance machinery (concern 24) is the
natural home for the gate.

## Provenance
Round-3 review, daemon agent item 6; carried from round-2's candidate inventory (test-mirror drift).
