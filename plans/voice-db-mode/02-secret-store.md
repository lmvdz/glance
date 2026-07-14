# Encrypted per-org secret store — table, migration, RLS, crypto
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/db/migrations.ts, src/db/schema.ts, src/secrets.ts (new), src/dal/store.ts, tests/secrets.test.ts (new), tests/org-secret-rls.test.ts (new), .env.example
MODE: afk

## Goal
A durable, org-scoped, encrypted-at-rest store for one provider credential per org, reachable only through the
org-scoping DAL path — the substrate every later concern reads.

## Approach
**Table `org_secret`**: `org_id` (FK `organization.id`, `ON DELETE CASCADE`), `provider` (text, `openai` today),
`ciphertext` (bytea/text), `nonce`, `last4` (plaintext, rotation check only — *not* an identifier: OpenAI keys
share long prefixes), `enabled` (bool, the synchronous kill switch), `created_by`/`updated_by` (`db:<userId>`),
`created_at`/`updated_at`. Primary key `(org_id, provider)`.

**Three coordinated edits — schema.ts alone creates nothing and protects nothing:**
1. A numbered migration in the `migrations.ts` provider map (`migrateApp` runs it at boot).
2. The `AppDatabase` type entry in `schema.ts`.
3. An explicit **`rlsMigration(["org_secret"])`** entry. Without it the table has no Postgres RLS policy and is
   protected by the DAL's `where org_id` alone — unacceptable on a secret table. The existing RLS backstop covers
   only `BASE_APP_TABLES` + `FEEDBACK_TABLES`; add this table deliberately.

**Crypto (`src/secrets.ts`)**: AES-256-GCM, per-row nonce, key from `OMP_SQUAD_SECRETS_KEY` (a 32-byte value,
hex or base64). Read it **once at boot into a module-local and `delete process.env.OMP_SQUAD_SECRETS_KEY`** (and
its `GLANCE_` twin — env-compat mirrors them) so no future spawn site can re-leak it even if concern 01's scrub
is bypassed. Two independent defenses, deliberately.

Boot posture (operator decision 2026-07-14: **operator-supplied only**, no generate-on-boot): DB mode + voice
flag + missing/malformed secret ⇒ the voice lane reports `enabled:false` and mint returns 501. Never a 500 at
call time, never a dead daemon for tenants who don't use voice.

Decrypt is **fail-closed everywhere**: a decrypt error returns "no key" (never throws into a request, never falls
back to any other key). A wrong/rotated master secret degrades to "voice unavailable," honestly reported.

Store accessors (in `dal/store.ts`, org-scoped like every other tenant write): `getOrgSecret`, `putOrgSecret`,
`deleteOrgSecret`, `setOrgSecretEnabled`. Each guards `if (!orgId) return undefined` **before** calling the
org-scoping helper — that helper throws on an empty org id, and a DB session with no active org is a real,
reachable state.

## Cross-Repo Side Effects
None. `.env.example` gains `OMP_SQUAD_SECRETS_KEY` (the env-doc gate will fail the suite otherwise).

## Verify
- Round-trip: encrypt → persist → read → decrypt yields the original key; ciphertext ≠ plaintext on disk.
- Decrypt-fails-closed: a corrupted ciphertext / wrong master key returns "no key", never throws, never 500s.
- Master key is absent from `process.env` after boot (the module-local + delete).
- **RLS proof** (the load-bearing one): with two orgs' rows present, a query under org A's scoping context can
  never read org B's row — assert at the DAL layer, and on Postgres assert the policy exists (a `where`-clause-
  only test would pass even with RLS missing, which is precisely the hole).
- Cascade: deleting an org removes its secret row.
