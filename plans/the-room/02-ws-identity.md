# WS identity — resolve the human at socket upgrade
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts (upgrade path, SocketData, actorForSocket, presence), src/types.ts (Actor), tests
MODE: afk

## Goal
Every WS connection knows which human it is. Today SocketData carries only {id, role, orgId,
bootstrapAdmin} (src/server.ts:368-378) and actorForSocket mints role-synthetic actors — every
admin in an org is literally `web:admin` (src/server.ts:1162-1163). Multiplayer attribution,
presence, and membership all sit on this substrate (A-C2).

## Approach
1. Resolve the session at WS upgrade — the auth cookie already rides the upgrade headers (comment
   at src/server.ts:1354). Stamp userId + displayName into SocketData in DB mode.
2. actorForSocket returns `{id: "db:"+userId, displayName, origin:"local", role, orgId}` matching
   the HTTP-path actor shape (src/server.ts:1755-1760) so audit/RBAC attribution is consistent
   across transports.
3. Presence: per-user socket sets per org (a user with 3 tabs is one present human); expose
   `GET /api/presence` + a presence SquadEvent arm (or fold into channel events); per-org fan-out.
4. File mode: single shared "operator" identity, stated in code comment and docs — multiplayer
   channels are DB-mode-only (Lars ratified at design gate). No per-human file-mode identity.
5. This is a trust-path change: cross-lineage review (grok + codex) mandatory before merge.

## Cross-Repo Side Effects
None.

## Verify
- Two browsers, two DB-mode users, same org: each WS's audited actor id is distinct (`db:<userId>`),
  displayNames correct; presence shows two humans; closing all tabs of one drops exactly that one.
- File mode: identity is the operator; presence shows one; nothing crashes without a session.
- Existing WS auth/subprotocol handshake (["ompsq-token", auth], webapp/src/lib/ws.ts:29) unbroken.

## Resolution
Landed 2026-07-23 in train wave0b (PR #231): session-at-WS-upgrade identity, db:<userId> actors, per-user socket-set presence, file-mode operator identity. Cross-lineage reviewed (codex finding fixed, grok clean) + orchestrator auth review.
