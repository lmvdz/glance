# Spend controls that bound what the daemon can actually see
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03
TOUCHES: src/voice-token.ts, src/server.ts, src/dal/store.ts, src/audit.ts, tests/voice-spend.test.ts (new), tests/voice-token.test.ts, .env.example
MODE: afk

## Goal
Bound what a member can burn on the org's key. Today's cap counts **mints**, but every mint is a provider-side
credential and *all* duration/idle caps live in the browser — so an operator-tier member can skip the React app,
POST the mint route directly, and drive their own WebRTC client with no server-side bound at all. BYO changes who
*pays*, not who can *burn*.

## Approach
Three layers, each honest about what it measures.

**1. Establishment TTL.** Mint currently pins `expires_after: 3600`. The ephemeral key bounds the *establishment
window*, not session length (the provider caps sessions independently) — so shrink it to **120s**
(`OMP_SQUAD_VOICE_TOKEN_TTL_S`, default 120). A token unused immediately dies; hoarding hundreds for later stops
being possible. Call length is unaffected.

**2. Durable per-org concurrency cap.** Count this org's mint-audit rows inside the provider's max-session window
(60 min) and refuse beyond N (`OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG`, default 5). Derived from the audit table
(concern's own write, below) ⇒ restart-safe, correct across replicas, no unbounded in-memory map. This replaces
the draft's "second in-memory map keyed by org", which would inherit both defects of the existing one.

**3. Keep the existing per-user per-minute limiter as a cheap pre-filter.** Do not re-describe it as an org bound
— it keys `actor.id` (per *user*), is per-process, and never bounded an org. Fix its comment to say so.

**Mint audit (both modes — mints are unaudited today, everywhere).** On every successful mint write an audit
entry: actor `db:<userId>` (never role-derived), action `voice.mint`, provider, and the **provider's own session
id** (currently discarded from the mint response) so an admin can cross-reference their OpenAI dashboard. In DB
mode the write goes through the org-scoping helper (org id auto-stamps); in file mode it appends to the existing
audit log. This entry is *also* the concurrency cap's data source — one write, two jobs.

**Kill switch.** `enabled:false` on the org's row is checked synchronously at mint, so an admin can stop new mints
instantly without deleting (and re-pasting) the key.

**The honesty boundary — write it into the code comments, not just the plan:** the daemon never sees audio or
dollars. It can attribute *mint events per member*; it **cannot** attribute spend. No surface may render a
per-member or per-call dollar figure. A rate cap is not a budget, and must not be described as one.

## Cross-Repo Side Effects
Webapp must not claim dollar figures (concern 06 copy).

## Verify
- TTL: minted token carries the configured `expires_after`; default 120.
- Concurrency: with N=2, a third mint inside the window refuses (429) and the refusal is auditable; after the
  window slides, mints resume. Prove it survives a **process restart** (the in-memory map cannot).
- Kill switch: flipping `enabled:false` refuses the *next* mint immediately; live sessions are documented as
  draining (the daemon has no provider revocation channel).
- Mint audit written in **both** modes, with actor `db:<userId>` in DB mode and the provider session id present.
- Mutation proof: remove the concurrency check → the N+1 test goes red.
