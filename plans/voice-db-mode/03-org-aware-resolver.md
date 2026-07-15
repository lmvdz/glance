# One org-aware voice resolver — all four gates move in lockstep
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 02
TOUCHES: src/voice-token.ts, src/server.ts, tests/voice-token.test.ts
MODE: afk

## Goal
Config-probe truth and mint outcome **cannot disagree** for any (mode, org, key-state) combination. Today four
separate reads consult the process-global env; if only some become org-aware, the probe advertises a voice button
whose mint 403s — the "old mic scar" the current code comments were written to prevent.

## Approach
Collapse every voice capability read into **one** async, org-aware resolver, and route all consumers through it:

| Consumer | Today | After |
|---|---|---|
| `voiceProviderApiKey(id)` | `process.env` read | `voiceKeyFor(orgId \| null, id)` |
| `hasAnyVoiceKey()` | env-only, global | `orgHasKey(orgId \| null)` |
| `voiceProviderPublicInfo()` | filters by env key | filters by the resolved org key |
| `GET /api/voice/config` (`server.ts:~1314`) | `dbMode \|\| !hasAnyVoiceKey()` ⇒ `enabled:false` | `flag && resolved key present && enabled` |
| `POST /api/voice/token` (`server.ts:~1326`) | `dbMode` ⇒ 403 | per-org refusal (501/403) when no key |

Resolver contract:
- `orgId === null` (file mode) ⇒ today's env read, byte-for-byte unchanged. File-mode behavior must not move.
- `orgId` present (DB mode) ⇒ store lookup + decrypt + `enabled` check. **No fallback to the operator's env key,
  ever** — that would silently reopen the shared-dollar hole this plan exists to close.
- No active org (a real, reachable DB state) ⇒ clean refusal, never a throw.
- Root-factory org gets **no bypass** — it configures a key like any other org or has no voice.

**Rewrite the stale rationale, don't just delete it.** The `MEDIUM-4` comments (`server.ts:~1308`, `~1326`) and
the header of `tests/voice-token.test.ts` state the file-mode-only premise ("single shared key, no per-org
attribution"). Replace them with the new rule — *DB-mode mint is refused only when the session org has no
configured, enabled key* — so the next reader inherits the current reason, not a dead one.

## Cross-Repo Side Effects
None (webapp probe is unchanged — it starts seeing `enabled:true` in DB mode once the server allows it).

## Verify
Existing pins that must **flip deliberately** (update, don't delete): the DB-mode 403 pin, the DB-mode
`{enabled:false}` pin. New pins:
- **Cross-tenant mint isolation** (the single most important test): two orgs with different keys; capture the
  `Authorization: Bearer` header at the mocked OpenAI endpoint; org A's session must mint with A's key and never
  B's. Extend the existing mint-mock harness to capture the auth header.
- **No env fallback**: operator env key set, org C has no row ⇒ mint refuses; it must *not* mint with the env key.
- **Probe/mint agreement**: for every (mode, org, key-state) combination, `config.enabled === (mint would 200)`.
- **Decrypt-fails-closed**: a corrupt row ⇒ `enabled:false` + refusal, never 500.
- Authz tiers unchanged (GET=viewer / POST=operator); viewer still gets no provider posture.
