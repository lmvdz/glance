# Design: Per-Org Voice Keys for DB-Mode Glance

## Approach

**Per-org BYO OpenAI keys in an encrypted `org_secret` table, heavily amended by the red-team panel.**
Each org's admin configures their own OpenAI key; mint uses the session org's key; orgs without one probe
`enabled:false` honestly. Attribution becomes the org's own OpenAI bill — the shared-dollar objection that
grounded the v1 file-mode-only refusal dissolves by construction rather than by policing a shared credential.

Two alternatives were weighed and rejected:

- **Operator-shared key + per-org budgets** — the daemon cannot see dollars (audio bypasses it entirely), so
  any cap is a proxy for spend, and the operator keeps 100% of the financial liability. A bug in the
  enforcement path reproduces the exact uncapped-spend failure this effort exists to close.
- **Per-project keys in env files** (`orgId → env file`, no DB, no crypto) — its headline benefit was
  "sidesteps the master-key leak," but that leak (F1 below) **must be fixed regardless**: `DATABASE_URL`
  already inherits into every tenant agent process today. Once the spawn scrub exists, this option's
  remaining advantages are one-time build cost, while its costs are permanent — plaintext keys at rest, a new
  `orgId → filesystem path` cross-tenant surface (the PR #152 defect class), and no self-serve onboarding or
  admin-driven rotation.

**Rewriting the stale rationale.** `server.ts:1308`/`:1326` currently say: *no per-org attribution/budget in v1
⇒ uncapped-shared-dollar shape ⇒ 403 in DB mode.* That premise is gone once mints run against the session org's
own key under a durable per-org cap. The new rule: DB-mode mint is refused only when the session org has no
configured, enabled key (or no active org) — a per-org refusal, not a mode-wide one.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Key storage | `org_secret` table, AES-256-GCM, boot secret held module-local | env-file per project; plaintext column | Spawn scrub owed regardless; ciphertext ≥ plaintext at rest; no `orgId`→path surface; self-serve rotation |
| CSP | Global, **nullary** `securityHeaders()`; widen `connect-src` when the lane is armed | Per-org org-aware widening (the draft) | The origin (`api.openai.com`) is identical for every org — only the *key* differs, and the key never touches CSP. Per-org CSP solves nothing and adds a silent-dead-call class |
| Key verification on save | `GET /v1/models` (200 vs 401); PUT itself rate-limited | Mint a token as a "dry-run" | The only mint call creates a **real 1-hour credential** — not a dry run, and unbounded on a hammered PUT |
| Mint TTL | `expires_after` 3600s → **120s** establishment window (env-overridable) | Keep 3600s; shrink to max call duration | The ephemeral key bounds *establishment*, not session length (the provider caps sessions independently). 120s kills token hoarding without touching call length |
| Org spend bound | **Durable per-org concurrency cap** derived from the mint-audit table (unexpired-window mints ≤ N, default 5) | A second in-memory map keyed by org | The in-memory map is per-process (×N replicas), unbounded in key count, and the existing one keys *per-user*, not per-org — it never bounded an org at all |
| Kill switch | `enabled` flag on the org's voice row, checked synchronously at mint | Delete-the-key as the only "off" | Instant, reversible, no re-paste; key deletion is all-or-nothing and lagged |
| Org switch mid-call | Client ends the call when `activeOrganizationId` changes | Server-side dispatch binding | The user is a legitimate member of both orgs — the risk is attribution confusion, not privilege escalation. Server-side binding of browser-originated tool calls is disproportionate for v1 |
| Daily $ budgets | Deferred to the org's own OpenAI dashboard | Persisted per-org dollar ceilings | The daemon cannot measure spend; a daemon-side dollar figure would be a lie |
| Per-member voice on/off | Deferred | Sub-budgets / member allowlists | Mint already requires operator tier; the funding implication is stated in admin UI copy instead |

## Security model

**What the crypto does and does not buy.** AES-256-GCM rows genuinely protect DB backups, remote-Postgres
compromise, SQL-injection reads, RLS-bypass reads, and accidental logging. They do **not** protect against
hostile code running same-uid on the daemon box — `/proc/<pid>/environ` exposes the exec-time environment and
the SQLite file is uid-readable. That boundary belongs to the agent sandbox, not this table, and the design
says so rather than implying at-rest crypto defeats a hostile tenant repo.

**The spawn-env scrub is ship-blocking and benefits the whole daemon.** The daemon spawns tenant agents with
full environment inheritance today (`agent-host.ts`, `omp-call.ts`, and `acp-agent-driver.ts`, which passes no
env at all). Only *gates* are scrubbed. So a master secret — and `DATABASE_URL`, already, today — lands in
every tenant's agent process: one hostile repo running `printenv` reads them. The scrub extends the gate
discipline to **all** tenant-agent spawn sites — the implementation found and closed *five* the draft's "three"
missed (`flue-service-driver.ts`, `validate.ts`, the workflow command nodes, and the `bun install` provisioning
in `worktree.ts`/`squad-manager.ts` whose hostile-postinstall reach was live-reproduced), plus a scrub *bypass*
one level up: `rpc-agent.ts` spawns the agent-host with the tenant worktree as cwd, so Bun auto-loaded a
tenant-controlled `bunfig.toml` preload inside the privileged host — closed by pinning `HOST_SPAWN_CWD` **and**
scrubbing the host spawn's own env (both `GLANCE_*` and `OMP_SQUAD_*` twins throughout).

The master-secret residual, corrected honestly after cross-lineage review (codex + grok independently):
`delete process.env.OMP_SQUAD_SECRETS_KEY` clears Bun's `process.env` object but **not** the kernel's
exec-time environ, so a key ingested via an env var still leaks through `/proc/<pid>/environ` to any same-uid
reader. The isolation-safe ingestion is therefore a **file**: `OMP_SQUAD_SECRETS_KEY_FILE` (and its `GLANCE_`
twin) names a path whose bytes are read straight into the module-local and never enter the environ at all. The
env-var path is kept for back-compat but is no longer claimed to be leak-proof. Boot check fails closed: DB
mode + voice flag + missing/malformed/unreadable secret ⇒ voice routes report `enabled:false` and mint 501s,
never a 500 at call time. The *irreducible* same-uid residual — a determined scan of every same-uid process's
`/proc` for the harness's own provider credential — remains owned by the sandbox workstream (Risks, below);
what this plan closes is the daemon-secret (`DATABASE_URL` / auth secret / master key) exposure specifically.

**RLS is explicit, not assumed.** App tables are created only by the migration provider map; the schema file is
types-only and protects nothing. The table ships as a numbered migration + an `AppDatabase` type entry + an
explicit RLS-policy migration, with `ON DELETE CASCADE` from `organization` per existing precedent. Every read
and write goes through the org-scoping helper, guarded by an explicit "no active org ⇒ clean refusal" check
*before* the call (the helper throws on an empty org id). No root-org bypass; an org key never falls back to the
operator's env key; file mode never reads the table.

**Gate lockstep.** Every voice capability read collapses into one org-aware resolver consumed by all gates — the
key lookup, the "any key?" probe, the public provider list, the config probe, and the mint path. The acceptance
invariant: config-probe truth and mint outcome cannot disagree for any (mode, org, key-state) combination. This
is the "old mic scar" pin, extended per-org.

**Revocation reality.** Deleting a key or flipping the kill switch stops new mints instantly but cannot recall a
live provider-side session. With the 120s establishment TTL, post-kill exposure is one provider-capped session,
not a fresh start window. Documented, not hidden.

## Spend & abuse controls

The daemon's honest position: **audio and dollars bypass it entirely; mints are its only spend signal.** Controls
therefore bound mints and concurrency, and no surface may claim per-member or per-call dollar figures.

1. **Establishment TTL 120s** — a minted token unused immediately dies; no hoarding hundreds of tokens for later.
2. **Durable per-org concurrency cap** — count mint-audit rows inside the provider's max-session window; refuse
   beyond N (default 5, env-overridable). Restart-safe, replica-correct, no unbounded map.
3. **Existing per-user per-minute limiter kept** as a cheap pre-filter — it was never the org bound, and now it
   doesn't have to be.
4. **Synchronous kill switch** at mint, independent of key deletion.
5. **Mint audit in both modes** — org-scoped, actor `db:<userId>` (never role-derived), recording the provider's
   own session id (currently discarded) so an admin can cross-reference their OpenAI dashboard. Mints are
   unaudited today in *both* modes; both close.
6. **Admin surface** — `PUT`/`DELETE /api/org/voice-key`, `GET /api/org/voice` (admin tier, session-org only:
   `{configured, last4, updatedAt, updatedBy, enabled}`). Below admin, the config probe returns the boolean only
   — no provider-posture leak. Admin copy states plainly: enabling voice funds every operator-tier member's
   dispatches on the org's key.

## Risks

- **Same-uid residual** — until tenant agent spawns are sandboxed like gates, hostile code on the daemon box can
  still reach the DB file and exec-time environ. Named, accepted, owned by the sandbox workstream.
- **Post-kill session tail** — a live call survives a key kill for up to the provider's session cap.
- **Lockstep regression** — a future gate added outside the single resolver reintroduces the config/mint
  disagreement; the disagree-pin test is the guard.
- **Cap tuning** — N=5 concurrent sessions per org is a guess; env-overridable, revisit with real usage.
- **Test-pin churn** — the CSP tests pin exact substrings; `securityHeaders()` stays zero-arg so those pins move
  rather than break.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| Master secret inherits into every tenant agent's env (and `DATABASE_URL` already does) | critical | Scrub all three spawn sites; boot secret module-local and deleted from `process.env`; same-uid boundary stated honestly |
| Per-org CSP is incoherent and adds a silent-dead-call class | critical | Rejected; CSP stays global and nullary |
| Mints ≠ spend: 6/min × 1-hour tokens = unbounded concurrent sessions on the admin's key | critical | TTL → 120s establishment; durable per-org concurrency cap; corrected premise (the key bounds establishment, the provider caps session length) |
| Rate cap is per-process and per-user, not per-org | critical | In-memory map demoted to pre-filter; org bound moved to the durable table-derived cap |
| Secret table would ship with no RLS (schema file creates nothing) | critical | Numbered migration + type entry + explicit RLS policy + cascade delete |
| "Verify before persist" mints a real credential, unbounded | significant | `GET /v1/models` verification; PUT rate-limited |
| Four env-only gates must migrate in lockstep or config lies | significant | One org-aware resolver; probe/mint-agreement pin |
| Org helper throws on an empty org id | significant | Explicit guard → clean refusal before the call |
| Mint audit discipline | significant | Org-scoped write, `db:<userId>` actor, provider session id; file-mode audit closed too |
| Org switch mid-call dispatches into the *other* org's fleet | significant | Client ends the call on org change; audit pins the minting org; narration tail documented |
| Key deletion is the admin's only lever, and it's lagged | significant | Synchronous kill switch + funding-implication copy |
| Six missing test pins | — | Adopted as acceptance tests (cross-tenant bearer capture, no-fallback, decrypt-fails-closed, probe leak, PUT-reject-writes-nothing, last4 length) |

## Open Questions

1. **Concurrency-cap and TTL defaults** (N=5, 120s) — env-overridable; decompose picks names consistent with the
   existing `OMP_SQUAD_VOICE_*` conventions. Resolvable at decompose.
2. **Admin panel placement** — RESOLVED (operator, 2026-07-14): a new admin-gated card inside the existing Organization settings screen, alongside Members / Join policy. No new nav surface.

3. **Boot-secret provisioning** — RESOLVED (operator, 2026-07-14): operator-supplied only. The daemon refuses to arm voice in DB mode without the secret set; no generate-on-boot (key material in logs + a state-dir wipe would silently brick every stored org key).

4. **Spawn-env scrub scope** — RESOLVED (operator, 2026-07-14): fixed inside this plan as concern 01. The per-org key story is incoherent without it, and it closes the live `DATABASE_URL` tenant leak now rather than later.
