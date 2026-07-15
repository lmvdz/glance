# Org-admin voice endpoints — set, verify, disable, remove the key
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 02, 03
TOUCHES: src/server.ts, src/org-admin.ts, src/authz.ts, src/schema/http-body.ts, src/voice-token.ts, tests/voice-org-admin.test.ts (new), tests/authz.test.ts
MODE: afk

## Goal
An org admin can configure, verify, disable, and remove their org's voice key — and can never touch another
org's, by construction.

## Approach
Three routes, alongside the existing `/api/org/*` admin idiom (`renameOrg` is the shape to mirror):

| Route | Tier | Behavior |
|---|---|---|
| `GET /api/org/voice` | admin | `{configured, last4, enabled, updatedAt, updatedBy}` — status only, never the key |
| `PUT /api/org/voice-key` | admin | Verify → persist (encrypted) → return status. Body validated by an Effect schema like every other wire input |
| `DELETE /api/org/voice-key` | admin | Hard-delete the row ⇒ org reverts to `enabled:false` |
| `POST /api/org/voice/enabled` | admin | Flip the kill switch without deleting the key |

**Org id comes from the session only, never the request body.** This is the PR #152 lesson (one org's admin could
register another org's worktree → cross-tenant read). There is no org parameter on any of these routes.

**Verification before persist** uses `GET /v1/models` with the candidate key (200 vs 401) — a free, side-effect-
free auth check. It must **not** use the mint endpoint: that creates a real, live provider credential, and an
unbounded PUT would mint them without limit. (The FileSignIn "verify before persist" precedent probes a *free*
endpoint — the UX pattern transfers, the endpoint choice does not.) The PUT route carries its own rate limit.

A rejected key **writes nothing** — no row, no `last4`, no partial state. `last4` is derived from the same bytes
that were just verified, in the same handler scope.

`last4` is a rotation check ("did I paste the key I think I did"), **not** an identifier — OpenAI keys share long
structured prefixes, so 4 trailing chars name nothing. Say that in the API doc and the UI label.

## Cross-Repo Side Effects
Webapp gains three calls (concern 06).

## Verify
- **Cross-tenant**: org A's admin session cannot read, write, or delete org B's key — no route accepts an org
  parameter, and the store call is session-org-scoped.
- **Tier**: member (operator tier) gets 403 on all four routes; admin succeeds. Pin in `authz.test.ts`.
- **PUT rejects a bad key and writes nothing** — assert no row exists after a rejected PUT (a partial write here
  would advertise a voice button whose mint 502s).
- **PUT never mints**: assert the verification call hits `/v1/models`, not `/realtime/client_secrets`.
- `GET /api/org/voice` never returns ciphertext or the plaintext key; `last4` is exactly 4 chars, absent when
  unconfigured.
- Rate limit on PUT holds.
