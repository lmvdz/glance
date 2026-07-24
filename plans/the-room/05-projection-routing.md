# Projection routing — unit events become channel cards, deterministically
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (spawn plumbing + projection), src/channels.ts, src/types.ts (CreateAgentOptions/AgentDTO channelId), src/schema/http-body.ts, tests
BLOCKED_BY: 01, 04
MODE: afk

## Goal
Every unit's proof events reach a channel by explicit rule (A-S5/B-F10): a unit records its
originating channelId at spawn/mention time and its events project there; unbound units (CLI, TUI,
factory, automation — the majority) project to the org default #fleet channel with card-kind
filtering so #fleet is not a firehose. Room cards and the needs-you/attention lane are two
projections of ONE event substrate — they cannot diverge.

## Approach
1. `channelId?` on CreateAgentOptions + persisted record + AgentDTO; /api/spawn and the mention
   path (concern 10) populate it; dispatcher/factory spawns leave it unset → #fleet.
2. Projection: on unit transcript entries bearing event.kind (concern 04), ChannelStore appends a
   pointer-card entry to the routed channel: payload {refs: {unitId, entryId? (optional hint —
   A-S7: never deref-required), planId?, landId?}, doorSurface, face: minimal pinned display
   fields}. Manager-authored only (concern 01 authorship rule).
3. Kind filter per channel kind: #fleet default set (needs-you, gate-verdict, land-merge) —
   config-extensible; originating channels get the full lifecycle.
4. needs-you lane relation: the attention/pending events that feed the ladder also project as
   needs-you cards — same substrate, one emit point, two projections (test that a pending request
   appears in both and resolves in both).
5. Neutralize + redact at projection (channel is human-read surface).

## Cross-Repo Side Effects
None (rendering is 08/12+).

## Verify
- Spawn via /api/spawn with channelId → cards land in that channel; CLI-spawned unit → #fleet.
- #fleet receives only filtered kinds (a land-attempt storm doesn't flood it).
- Pending request: card in channel + item in attention lane; answering resolves both.
- Two-org test: projections never cross orgs.

## Resolution
Landed 2026-07-23 (PR #231): channelId-at-spawn, #fleet default with kind filter, manager-authored pointer-cards, needs-you one-substrate with the attention lane. Two-org isolation tested.
