# M04 — release re-credential + rebrand (shippable installers)

STATUS: ✅ MERGED (gd#26) — updater/release URLs repointed to the fork, copy rebranded, docs/RELEASE.md runbook; real signed release is a Lars secrets rider (NOT RUN)
PRIORITY: p3
REPOS: glance-desktop (config/CI) + a Lars ops rider (secrets)
COMPLEXITY: architectural
TOUCHES: src-tauri/tauri.conf.json (updater endpoint/pubkey), src/modules/updater/useUpdater.ts (check URL), .github/workflows/release.yml (copy, target repo), AboutSection URLs (shared with M03)
BLOCKED_BY: M03 (rename lands first so release copy/URLs are already Glance)

## Goal

Glance ships as signed, auto-updating installers for macOS/Windows/Linux **from the fork's own release repo** — not upstream's. The pipeline already exists; this concern reconnects it, re-credentials it, and rebrands it.

## Ground truth (recon first — the pipeline is BUILT, not missing)

- `tauri.conf.json` bundle config is complete (all targets, macOS entitlements, Linux deb/rpm/appimage, Windows NSIS + installer hooks). Updater configured with a real minisign `pubkey`.
- `.github/workflows/release.yml` is a mature 4-target signed matrix (macOS aarch64/x86_64, ubuntu, windows) with Apple notarization + AppImage wayland fix + `latest.json` patching. `ci.yml`, `signpath-test.yml` also present.
- **The gaps (all "reconnect/re-credential/rebrand", not "build"):**
  1. Updater endpoint (`tauri.conf.json:111`), About page URLs, and updater check URL (`useUpdater.ts:10`) ALL point at `github.com/crynta/terax-ai` → auto-update pulls from the WRONG repo.
  2. The embedded `pubkey` must match a minisign keypair THIS fork owns, or update signatures fail.
  3. CI signing secrets (Apple certs, the Tauri signing key, SignPath token) presumably absent in the fork's repo.
  4. Release copy still "Terax" (`release.yml` `releaseName: "Terax ${tag}"`).

## Approach

1. **Repoint** every `crynta/terax-ai` release/updater/About URL to the fork's release repo (coordinate the About-URL change with M03).
2. **Updater keypair**: generate a fork-owned minisign keypair, embed the new public key in `tauri.conf.json`, and hand Lars the runbook to hold the private key as the `TAURI_SIGNING_PRIVATE_KEY` secret. (Do NOT commit or fabricate keys.)
3. **Release copy**: `release.yml` `releaseName` and any Terax strings → Glance.
4. **Secrets rider (Lars action)**: produce the exact list of GitHub secrets the pipeline needs + `gh secret set` commands, and what each is for (Apple cert/notarization, Tauri key, SignPath). The code ships without them; a real signed release needs Lars to provision them. Never flip repo visibility or enable public CI.

## Acceptance

- Every release/updater/About URL points at the fork's repo (grep clean of `crynta/terax-ai`). RAN / result.
- `tauri build` produces installers locally (unsigned is fine for the code proof). RAN / result (or NOT RUN + why if the toolchain isn't present).
- A dry-run of the updater check hits the fork's `latest.json` URL (not upstream). RAN / result.
- **NOT RUN (Lars rider)**: a real signed, notarized, auto-updating release — needs the provisioned secrets + the fork's keypair. Ship the runbook + secret list; mark this bullet NOT RUN with the exact unblock.
- Gate: tsc + lint + build; the workflow yaml lints/parses.

## Non-goals / deferred

- Provisioning the actual secrets/certs (Lars's to hold).
- A public marketing site / auto-update channel beyond GitHub Releases.
