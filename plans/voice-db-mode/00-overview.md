# Voice lane in DB (multi-tenant) mode

## Outcome
An organization on a DB-mode (multi-tenant) glance daemon can use the voice lane: an org admin pastes their own
OpenAI key into Organization settings, and every operator-tier member of that org can talk to the fleet. Each
org's voice spend lands on **its own OpenAI bill** — the shared-dollar objection that made v1 file-mode-only is
gone by construction. Orgs without a key honestly show no voice button.

Along the way this closes a **live multi-tenant security hole that has nothing to do with voice**: today every
tenant agent process inherits the daemon's full environment, including `DATABASE_URL`.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 Spawn-env scrub](01-spawn-env-scrub.md) | Tenant agents inherit the daemon's secrets today (`DATABASE_URL` included). The per-org key story is incoherent without this, and it's a live hole regardless | architectural | agent-host, omp-call, acp-agent-driver, new spawn-env |
| [02 Encrypted secret store](02-secret-store.md) | Nowhere to put an org's key. Table + migration + **explicit RLS** + AES-GCM; boot secret held module-local | architectural | db/migrations, db/schema, new secrets.ts, dal/store |
| [03 Org-aware resolver](03-org-aware-resolver.md) | Four env-only gates must move in lockstep or the config probe advertises a button whose mint 403s | architectural | voice-token, server, voice tests |
| [04 Spend controls](04-spend-controls.md) | Today's cap counts *mints*, but each mint is a live credential and duration caps are browser-side — a member can burn the org's key with no server bound | architectural | voice-token, server, dal/store, audit |
| [05 Admin endpoints](05-admin-endpoints.md) | Set / verify / disable / remove the org's key; session-org only, never a request parameter | architectural | server, org-admin, authz, http-body schema |
| [06 Org settings UI](06-org-settings-ui.md) | Where the admin actually does it — plus the copy that says what enabling voice funds | mechanical | webapp OrgSettings, webapp api |
| [07 CSP + org switch](07-csp-and-org-switch.md) | Without CSP arming the browser can't reach the provider (the 2026-07-13 silent-death class). Org switch mid-call would dispatch into the *other* org's fleet | mechanical | server, voice-token, VoiceCallContext |
| [08 Live verification](08-live-verify-db-voice.md) | Two orgs, two keys, one daemon, a real call, a real mic. Every unit test can be green while the composed lane is dead — that is exactly what happened last time | architectural | (verification run) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Ship-blocking security fix; stands alone and lands first (it's independently valuable) |
| 2 | 02 | Substrate every later concern reads |
| 3 | 03 | The gate lockstep; needs the store |
| 4 | 04, 05 | Both build on the resolver; disjoint files (spend path vs admin routes) — parallel, worktree-isolated |
| 5 | 06, 07 | UI + CSP/org-switch; disjoint (webapp card vs server header + call context) — parallel |
| 6 | 08 | Live verification of the composed system |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `src/spawn-env.ts` exists and all three spawn sites import it |
| 03 | 02 | `org_secret` migration is in the provider map **and** the RLS list |
| 04 | 03 | One resolver; no `process.env` voice-key read outside it |
| 05 | 02, 03 | Store accessors exist; resolver refuses cleanly with no active org |
| 06 | 05 | The four admin routes answer |
| 07 | 03 | Resolver reports org key state |
| 08 | 01–07 | All merged; a DB-mode scratch daemon boots |

## Not yet specified
- (none)

## Out of scope
- **Daily dollar budgets** — the daemon never sees audio or dollars; a daemon-side dollar figure would be a lie.
  The org's own OpenAI dashboard is the correct enforcement point. The honest daemon-side control is the
  concurrency cap in 04.
- **Per-member voice on/off and sub-budgets** — mint already requires operator tier; the funding implication is
  stated in the admin UI copy instead. Revisit if a real tenant asks.
- **Server-side dispatch binding for org switch** — the user is a legitimate member of both orgs, so the risk is
  attribution confusion, not privilege escalation; the client ends the call instead (07).
- **Revoking a live provider session** — no such channel exists. The 120s establishment TTL bounds the blast
  radius; the drain is documented, not hidden.
- **Per-project keys in env files** (the no-crypto alternative) — rejected: its "sidesteps the master-key leak"
  benefit is hollow (the spawn scrub is owed regardless, per 01), and it adds an `orgId`→filesystem-path
  cross-tenant surface while forfeiting self-serve rotation.

## Decisions so far
- [Boot-secret provisioning](DESIGN.md) — operator-supplied only, fail-closed; no generate-on-boot (key material in logs; a state-dir wipe would silently brick every stored org key).
- [Admin panel placement](06-org-settings-ui.md) — a card inside the existing Organization settings screen; no new nav.
- [Spawn-env scrub scope](01-spawn-env-scrub.md) — fixed inside this plan as concern 01, not split out.

## Notes
- **The honesty boundary, in code comments and UI copy alike:** glance can attribute *who minted*, never *what
  was spent*. Audio never transits the daemon. No surface may render a per-member or per-call dollar figure, and
  a rate cap must never be described as a budget.
- Adversarial design panel ran 2026-07-14 (designer → 2 red teams → arbiter). Both red teams found criticals the
  draft missed; the arbiter overturned three draft decisions (per-org CSP, mint-as-dry-run verification, the
  in-memory org rate cap) and corrected both red teams on what the token TTL actually bounds. Detail in DESIGN.md.
- Proceeded over an existing WIP pile (largest: meta-plan-autonomous-fleet, 37 open) with the operator's explicit
  go.
