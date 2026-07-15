# M03 — identity deep rename (Terax → Glance) + data migrations

STATUS: ✅ MERGED (gd#25) — independently re-gated (tsc/lint 103/vitest 510/vite build/cargo check all green) then self-merged past the inherited-broken fork CI (Lars-authorized bypass); migration cross-lineage read (grok) found+fixed 3 data-loss classes
PRIORITY: p3
REPOS: glance-desktop (+ src-tauri Rust)
COMPLEXITY: architectural
TOUCHES: ~103 files, ~450 "terax" hits — categorized below. The migration-sensitive core is the persisted-data keys.
BLOCKED_BY: —

## Goal

Finish what C02's rebrand-lite started: the app is Glance inside and out — the AI persona, the crate, the persisted stores, the project-memory convention, the visible copy — with **zero user-data loss**. This is the point the fork commits to hard divergence from upstream terax.

## Ground truth (recon first — census already done, verify counts before editing)

Categories (file:line anchors in the Epic M overview's ground-truth section):
- **(c) MIGRATION HAZARDS — persisted data keys.** Renaming these orphans user data unless migrated: store files (`terax-ai-sessions.json`, `terax-settings.json`, `terax-spaces.json`, `terax-ai-agents.json`, `terax-ai-todos.json`, `terax-ai-snippets.json`), the AI-provider **keyring service `"terax-ai"`** (orphans saved API keys — highest-value data), IndexedDB `terax-bg-images`, and the many `terax-*`/`terax.*` localStorage keys. THIS IS THE DANGEROUS PART.
- **(b) AI persona "Terax"**: `config.ts` SYSTEM_PROMPT / SYSTEM_PROMPT_LITE, "Ask Terax anything" (×several), notification strings, and the external leak `agent.ts:158` `HTTP-Referer: https://terax.ai` / `X-Title: Terax`.
- **(d) `TERAX.md`**: reader (`transport.ts:15`), prompt header (`agent.ts:319`), `/init` generator, existing files.
- **(a/e) crate + JS↔Rust event strings**: `Cargo.toml` `name`, `terax:*` / `terax://*` events (change BOTH sides together, or the app breaks).
- **(e) visible copy**: Quit dialog, theme "Terax Default" + `.terax-theme`, `AboutSection` URLs (`crynta/terax-ai`, `terax.app`).
- **(f) CSS classes** `terax-*` — cosmetic, do last (bulk rename, low risk).

## Approach

1. **Migrations FIRST, tested.** For each persisted key, a one-time read-old-write-new migration that falls back to the old key if the new one is absent (so an upgraded user keeps their sessions/keys/settings). Unit-test the migration set: every old key maps to exactly one new key, no data loss, idempotent (running twice is a no-op). The AI-provider keyring migration is the highest-stakes — get it right or users lose API keys.
2. **`GLANCE.md` accepts the old name**: read `GLANCE.md` then fall back to `TERAX.md` so existing project-memory files keep working; `/init` writes `GLANCE.md`.
3. **Coordinated event rename**: `terax:*`/`terax://*` → `glance:*`/`glance://*` on BOTH the JS emitters and the Rust `lib.rs` handlers in the same commit.
4. **Persona + copy**: Terax → Glance in prompts/copy/notifications; fix the `terax.ai` referer/title leak.
5. **Crate**: `Cargo.toml` name → glance; verify `cargo check` (PKG_CONFIG_PATH fix).
6. **CSS classes** last as a mechanical bulk rename.

## Acceptance

- Fresh install presents as Glance everywhere (no "Terax" in any user-visible surface). RAN / result.
- An UPGRADE (old `terax-*` stores/keys present) preserves sessions, settings, spaces, AND saved API keys — nothing re-entered. RAN / result (seed old-named stores, launch, verify data carried over).
- `cargo check` green after the crate + event rename; the app boots and JS↔Rust events still fire. RAN / result.
- Gate: tsc + lint + vitest (incl. migration tests) + build + cargo check.
- Cross-lineage read on the migration set (data-loss / double-migrate) even though it's not a daemon write — the destructive-if-wrong property warrants it.

## Non-goals / deferred

- The release-pipeline URL/keypair rebrand (M04).
- Renaming the upstream `origin`/`upstream` git remotes or the repo itself.
