# Room messaging — humans talk, presence shows
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/hub (composer wiring, presence UI), src/server.ts (channel post command/endpoint), src/channels.ts, webapp/src/lib/chat/sendCore.ts, tests
BLOCKED_BY: 01, 02, 07
MODE: afk

## Goal
The composer posts to the channel; other humans see it live with correct attribution
(displayName from concern 02); presence renders (who's here) in the rail/header. This is the
wave-2 gate-opener: the room becomes a chat workspace, not a feed (B-F1).

## Approach
1. Channel post path: composer submit in hub context → channel post (HTTP or WS command) →
   ChannelStore append (redact chokepoint; event field stripped per authorship rule) → per-org
   fan-out. Draft persistence per existing draftStore pattern keyed by channelId.
2. Attribution renders author displayName + agent/human distinction on every entry.
3. Presence UI: per-user socket-set data (concern 02) → avatars/count in channel header; stub
   fidelity (online/offline; typing indicators are concern 19).
4. File mode: single operator identity — posting works, presence shows one.

## Cross-Repo Side Effects
None.

## Verify
- Two browsers, two DB users: A posts, B sees it live with A's name; presence shows both; B's
  history after reload is complete (durable rows).
- Composer drafts survive reload per channel. Existing sendCore/Composer tests green.
