# Epic M — Multi-daemon, identity, release

Parent: plans/fleet-first-ide/00-meta.md · Charter: plans/fleet-first-ide/05-multidaemon-identity.md
Expanded 2026-07-15 (trigger met: Epic C merged, suite in daily use). Grounded on a fork surface map (connection model + a ~450-hit "terax" branding census + the release/updater config + the remote/CSP constraints), file:line refs per concern.

## Outcome

The fork stops being "terax with a fleet panel" and becomes **Glance the product**: it is fully branded Glance (not just the Tauri shell C02 flipped — the app interior, the AI persona, the crate, the persisted stores), it ships as **signed, auto-updating installers** for macOS/Windows/Linux from the fork's OWN release repo (not upstream's), and it connects to **more than one daemon** — local and remote-over-https — with the fleet view spanning hosts. This is where the fork commits to hard divergence from upstream terax (the deep rename is that commitment).

## Ground truth (from the fork surface map — consume, don't rebuild)

**Multi-daemon — EXISTS / MISSING:** the cockpit connects to exactly ONE daemon today — a hard singleton at every layer: `fleetConfig.ts` stores a single scalar `daemonBaseUrl` (default `http://127.0.0.1:7878`); `fleetKeyring.ts` holds ONE token under a fixed account; `fleetConnectionStore.ts` has a single `baseUrl` + an `initPromise` "one connection per window"; `fleetRosterStore.ts` re-derives that singleton and polls one `GET /api/agents` with module-level `timer`/`inFlight`/`notifiedAttention`; `FleetSection.tsx` is a single-row form. **The clean seam: `FleetClient` is already stateless per-instance** (`new FleetClient({baseUrl, token})`) — only the config/keyring/stores/UI above it hardcode the singleton. No daemon id/label, connections array, active-daemon concept, or per-daemon token exists — multi-daemon is greenfield on a singleton.

**Remote daemon — mostly works already:** CSP `connect-src` allows `https:` (any host) → a remote https daemon is reachable; `FleetClient` is host-agnostic (`normalizeBaseUrl` accepts https, Bearer token sent regardless). The ONLY loopback gate in the fleet path is "open worktree as a Space" (`worktreeOpener.isLoopbackDaemon` → `RosterView.tsx:135` hides it for remote) — already correct. **No SSH came across from upstream** (no ssh2/russh in Cargo, no ssh module) — so "cross-host" is https+token, not SSH tunneling. Poll-only stands for remote too (no `ws:`/`wss:` in CSP).

**Identity/branding — ~450 "terax" hits across 103 files, categorized (C02 flipped only the Tauri shell):**
- **Migration-HAZARD data keys** (rename orphans user data → need read-old-write-new): store files `terax-ai-sessions.json`/`terax-settings.json`/`terax-spaces.json`/etc., the AI-provider keyring service `"terax-ai"` (orphans saved API keys!), IndexedDB `terax-bg-images`, many `terax-*`/`terax.*` localStorage keys.
- **AI persona "Terax"** (biggest user-visible, ~30 in `src/modules/ai/`): `SYSTEM_PROMPT`/`SYSTEM_PROMPT_LITE` name the agent, "Ask Terax anything", notification strings, and an external identity leak (`agent.ts:158` `HTTP-Referer: https://terax.ai`, `X-Title: Terax`).
- **`TERAX.md`** project-memory convention: reader (`transport.ts:15`) + prompt header (`agent.ts:319`) + the `/init` generator + existing files → rename to `GLANCE.md` but accept the old name for back-compat.
- **Crate + JS↔Rust event strings** (coordinated rename): `Cargo.toml` `name="terax"`/`terax_lib`; event names `"terax:open-file"`/`"terax:settings-tab"`/`terax://*` must change on BOTH sides together.
- **Visible copy**: Quit dialog "Quit Terax?", theme "Terax Default" + `.terax-theme` extension, `AboutSection` URLs pointing at `github.com/crynta/terax-ai` + `terax.app`.
- **CSS classes** `terax-*` (bulk cosmetic, low priority).

**Release — SUBSTANTIALLY BUILT (reconnect + re-credential + rebrand, NOT build-from-scratch):** `tauri.conf.json` bundle is complete (all targets, macOS entitlements, Linux deb/rpm/appimage, Windows NSIS + installer hooks); updater is configured (real minisign pubkey); `.github/workflows/release.yml` is a mature 4-target signed matrix (macOS aarch64/x86_64, ubuntu, windows) with Apple notarization + an AppImage wayland fix + `latest.json` patching. **The gaps are:** (1) the updater endpoint (`tauri.conf.json:111`), the About page, and the updater check URL (`useUpdater.ts:10`) ALL point at `crynta/terax-ai` → **auto-update pulls from the WRONG repo**; (2) the embedded `pubkey` must match a minisign keypair THIS fork owns, or signatures fail; (3) CI signing secrets (Apple certs, Tauri key, SignPath token) presumably don't exist in the fork's repo; (4) release copy still "Terax". Secrets provisioning is a **Lars action** (his keys/certs), not code.

## Work

| Concern | Repo | Why it exists | Complexity | Depends |
|---|---|---|---|---|
| 01 multi-daemon-connection | glance-desktop | generalize the singleton → a connections list (id/label/url), per-daemon tokens (keyring keyed by id), a connections store with an active-daemon selector + per-daemon status, FleetSection list-CRUD + switcher. Remote https is just a URL variant (token required, worktree-open already gated). `FleetClient` unchanged. | architectural | — |
| 02 cross-host-fleet-view | glance-desktop | the fleet roster/attention SPANS all connected daemons — poll each, merge into one roster with each unit tagged by daemon/host; generalize `fleetRosterStore` off the singleton. The "fleet view spans hosts" payoff. | architectural | 01 |
| 03 identity-deep-rename | glance-desktop (+ src-tauri Rust) | the full Glance rename WITH data migrations: read-old-write-new for every `terax-*` store/keyring/DB/localStorage key; AI persona Terax→Glance (prompts/copy/notifications + the terax.ai referer leak); `TERAX.md`→`GLANCE.md` (accept old); crate + JS↔Rust event-string rename; About URLs, Quit dialog, theme name/extension. **This is the hard-divergence commitment.** | architectural | — |
| 04 release-recredential-rebrand | glance-desktop (config/CI) | repoint every `crynta/terax-ai` release/updater URL to the fork's repo; own the updater minisign keypair + matching pubkey; rebrand release copy; document + provision the CI signing secrets (a Lars ops rider). Makes the branded build shippable + auto-updating from the right place. | architectural | 03 (rename lands first so release copy/URLs are Glance) |

## Order

| Batch | Concerns | Why |
|---|---|---|
| 1 | 01, 03 | independent: 01 is the connection refactor, 03 is the rename — parallel-safe |
| 2 | 02, 04 | 02 needs 01 (spans the connections it manages); 04 lands after 03 so release URLs/copy are already Glance and the updater keypair rebrand is coherent |

## Discipline (inherited from the meta-plan)

- All concerns are glance-desktop (Epic M is fork-only); gate = tsc + lint (baseline 103) + vitest + build (+ `cargo check` with the PKG_CONFIG_PATH fix for 03's Rust rename). No omp-squad daemon changes → **no cross-lineage gauntlet** for 01/02/04. **03 is the exception worth extra care**: the data migrations are user-data-destructive if wrong (a mis-migration silently orphans sessions/API-keys) — each `terax-*`→`glance-*` key needs a read-old-write-new-once migration with the old key as fallback, and the migration logic should be unit-tested. A cross-lineage read on the migration set (does any key lose data / double-migrate?) is warranted even though it's not a daemon write.
- **03 is the hard-divergence point** (meta decision: acceptable once the fleet module is primary — it is, Epic C shipped). Renaming the crate + stores + event contract ends additive-only discipline; after 03, upstream rebases (Epic C concern 03's protocol) get materially harder. Sequence 03 deliberately and note it in the ledger.
- **04's secrets are Lars's to provision** (Apple certs, the fork's Tauri signing key, SignPath token, the updater minisign keypair). The concern ships the code (repointed URLs, rebranded copy, a keypair-generation runbook) and hands Lars the exact secret list + `gh secret set` commands — it does NOT fabricate or commit secrets, and never flips repo visibility or enables public CI (standing caution).
- Remote-daemon transport stays poll-only (CSP forbids `ws:`/`wss:`); do not widen CSP to add a socket without a deliberate security review.
