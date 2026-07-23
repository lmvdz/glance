# Agent grants — provenance + explicit revocation via remove()
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/db/schema.ts, src/db (DAL), src/manager-registry.ts (revocation entry point only — NOT protectedIds), src/server.ts (admin endpoint), tests
MODE: afk

## Goal
Every DB-mode agent records WHO vouched for it (owner provenance), and revoking that trust removes the agent through the front door. Borrowed from buzz's NIP-OA/NIP-AA cascade-revocation model, reshaped hard by design review: the reaper NEVER reads grants, and revocation requires positive evidence — never inference from membership absence (the PR #217 friendly-fire class, and the absence-invariant scar).

## Approach
1. New `AgentGrantTable` in src/db/schema.ts (org_id-scoped like every table there): `{ org_id, agent_id, owner_user_id, granted_at, revoked_at, revoked_by }`. Copy `owner_user_id` as a plain column — NO foreign key into better-auth's tables (schema.ts:5-8 explicitly keeps the DAL out of them; member ids are also unstable across remove/re-add). No `expires_at` — nothing time-based that a janitor could act on.
2. Write side: stamp a grant row at agent creation in DB mode (creating Actor's user id = owner). Backfill migration for existing roster rows from the audit trail where derivable; underivable rows get a sentinel owner and stay fully protected.
3. Revocation is an explicit operator/admin action (endpoint + audit entry): sets `revoked_at`/`revoked_by`, then drives `manager.remove(agentId)` on the owning org's manager — the durable tombstone path that settles pendings and prevents `ensureConnected` respawn (src/squad-manager.ts:7007). Cascade = the endpoint accepts an owner id and revokes all their grants in one audited action (e.g. invoked when an org removes a member — but always as an explicit call, never a background inference).
4. `protectedIds()` (src/manager-registry.ts:175) and the reap path are UNTOUCHED. A grant lookup failing, missing, or dangling changes nothing about protection — grants are provenance + a removal trigger, not a liveness input.
5. File mode: no-op by construction (ManagerRegistry unused; no DB).

## Cross-Repo Side Effects
None.

## Verify
- DB-mode scratch daemon: create agent → grant row exists with correct owner; revoke → agent tombstoned (roster shows removed, pendings settled), host gone, and it does NOT respawn on steer.
- Reap regression: with grants table empty/dropped mid-run, protectedIds behavior byte-identical (unit test); no reap-path code imports the grants DAL (grep assertion in test).
- Cascade: revoke-by-owner removes all their agents in one action, each with its own audit entry.
