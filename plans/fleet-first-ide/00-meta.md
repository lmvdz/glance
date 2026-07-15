# Fleet-first IDE — meta-plan

STATUS: in-progress
PRIORITY: p0
REPOS: omp-squad, glance-desktop (to be created)
COMPLEXITY: architectural

## North star

One desktop app that is the developer's entire interface to a software factory — **fleet-first where VS Code is file-first** — with zero-friction drop-down from supervising N units to hands-on-keyboard in one worktree. Glance daemon = the factory; a terax fork = the cockpit; the worktree is the join everywhere. Full vision and verified source evidence: `plans/research-terax-ai/BRIEF.md` (terax inspected at commit `a2c8329`, 2026-07-14).

Product identity at the end: **glance = daemon (factory) + desktop (cockpit) + web (away-from-desk)**.

## Decisions (locked unless Lars overrides)

- **Skip v0-as-milestone**: go straight at the end state (Lars, 2026-07-14). The v0 pieces become Epic B (bridge substrate) — they are prerequisites, not a separate destination.
- **Fork, not upstream PRs**: contributors tried twice to land protocol-grade agent integration in terax (#193 ACP, #684 universal registry) — both closed unmerged. The maintainer gatekeeps hard. Fork it (Lars, 2026-07-14).
- **Fork mechanics**: NOT a GitHub fork (public parent forces public fork). New **private** repo `glance-desktop` under Lars's account, cloned from `crynta/terax-ai` latest main at bootstrap time, `upstream` remote retained for rebases, bootstrap SHA recorded in UPSTREAM.md. Visibility flip to public is Lars's call, later.
- **Additive-only fork discipline** until the fleet module is the primary surface: new `src/modules/fleet/` + minimal registration touches + name/icon rebrand-lite. Deep rebrand deferred — it multiplies rebase conflict surface for zero function. Upstream merges dozens of PRs/week; rebase on a cadence (Epic C concern 03).
- **The daemon stays the brain.** No fleet logic moves into the cockpit's Rust/webview. The cockpit is a client of the daemon's existing REST/SSE API (terax CSP already allows `connect-src http://localhost:*` — verified).
- **Merge policy**: the goal loop opens draft PRs and never merges. Lars merges (bg classifier denies `gh pr merge`; hand him a `!` loop when a batch is ready). The loop prefers concerns that are independent of unmerged predecessors; it stacks PRs only when forced and records the stack order in the ledger below.
- **Model routing** per CLAUDE.md: judgment/planning = fable (opus fallback); in-repo iterative implementation = sonnet subagents; mechanical isolated diffs = codex (gpt-5.6); wide sweeps + third-lineage review = grok. Cross-lineage review (codex AND grok) on anything touching trust/security/git-write paths.

## Epics

| Epic | Charter | What it delivers | Sub-plan | Status |
|---|---|---|---|---|
| B | 01-bridge-substrate.md | OSC attention lane, `glance open`, hook self-reporting (glance-side; no fork needed) | plans/fleet-ide-bridge/ | expanded, open |
| C | 02-cockpit-fork.md | Private fork bootstrapped, rebrand-lite, rebase protocol, native fleet module (roster/attention/intervene/Space-join/bell) | plans/fleet-ide-cockpit/ | expanded, open |
| I | 03-shared-workspace-intervention.md | Intervene = shared worktree: presence/leases in editor, ACP conversation pane, hand-back | charter only — loop expands when C04–C07 land | blocked |
| E | 04-chat-unit-escalation.md | Chat panel backed by daemon; promote conversation → gated landable unit; adopt ad-hoc CLI sessions | charter only — loop expands when I unblocks | blocked |
| M | 05-multidaemon-identity.md | Multi-daemon connection manager, cross-host fleet, identity/branding pass, release pipeline (installers) | charter only — loop expands when C lands | blocked |

## Dependency graph

- B has no dependencies (pure glance-repo work; parallel-safe with C).
- C01 → C02 → C03; C01 → C04 → C05 → C06/C07/C08.
- I blocked by C04–C07 and B03. E blocked by I. M blocked by C (module stable) and can run parallel to I/E.

## Goal loop

Runs under `.claude/skills/fleet-ide-loop/SKILL.md`: each iteration orients here, picks the highest-priority unblocked open concern, implements it (worktree in omp-squad, or the glance-desktop clone for cockpit concerns), gates it, ships a draft PR, flips STATUS, appends to the ledger, and schedules its own next wakeup. Stop condition: every epic's concerns done or explicitly descoped by Lars.

## Merge state (2026-07-14, Lars's first merge pass)

- MERGED: #174 (meta-plan), #177 (B01 OSC lane), #179 (B03 harness hooks), glance-desktop#2 (C01 bootstrap).
- #178 (B02 glance-open) conflicted with B03 on `src/server.ts` imports + `src/index.ts` (help/case/cmd) + `.env.example` — the sibling-squash composition-drift pattern (see [[omp-squad-merge-train-ratchet-drift]]). Rebased onto new main, resolved keep-both, re-gated (tsc + touched tests + live smoke: B02 route and B03 harness-events co-resident, help lists both), force-pushed with lease → now MERGEABLE. Awaiting Lars's merge.
- **C01 merged ⇒ Epic C unblocked** (C02 rebrand-lite, C03 rebase-protocol, C04 fleet-module-skeleton all now selectable by the loop).

## Ledger

(loop appends one line per iteration: date, concern, outcome, PR)

- 2026-07-15 — iteration 10: C07 intervene pane shipped as glance-desktop#15 — click a roster row → why-stopped + diff-as-spine + steer composer (POST /api/command prompt, webapp's shape). Both new endpoint contracts (diff, command) verified live against a real daemon. Gate green (vitest 376). **Only C08 (bell deep-links) remains in Epic C.** After C08 merges, Epic C is DONE and Epic I (shared-workspace intervention) unblocks (needs C04-C07 + B03, all merged/merging).
- 2026-07-15 — iteration 9 (Lars: "go"): C06 worktree↔Space join shipped as glance-desktop#14 — THE fleet→ground gesture: click a roster row → its worktree opens as a Space (terminal at root, editor, git). create-or-focus (no dupes) + loopback gating, both tested; worktree field source-verified on the real daemon DTO; App-registered opener mirrors setLspNavigator. Gate green (vitest 370). Next: C07 (intervene pane — needs C05, now merged, so unblocked) or C08 (bell deep-links). C06 itself is unmerged but C07/C08 don't depend on it (both need C05 which IS merged) — so C07 is independently shippable.
- 2026-07-15 — C05 (#11) + C03 (#12) MERGED. Drift Action verified green post-merge (run 29384237925 → tracker issue #13, CLEAN). **Epic C is now: C01/C04/C02/C05/C03 all DONE+merged; only C06/C07/C08 remain, all unblocked by C05.** Next: C06 (worktree↔Space join — the gesture that closes the fleet↔ground loop in-app).

- 2026-07-14 — iteration 8: C03 rebase-protocol shipped as glance-desktop#12 — drift forecaster (verified live: CLEAN + forced-conflict detection both work) + weekly Action + UPSTREAM.md runbook. Found GH Actions already ON with terax's ci.yml green on our PRs (bonus independent gate). **C03 was the last fully-independent concern** — C06/C07/C08 all need C05 (#11) merged. Loop is now MERGE-GATED: after C05 lands, C06 (worktree↔Space join) is next. 4 fork PRs now open (#9,#10 merged; #11 C05, #12 C03 pending) + dependabot.
- 2026-07-14 — iteration 7: C05 roster+attention shipped as glance-desktop#11 — the cockpit now RENDERS the live fleet (attention queue + roster, polling GET /api/agents, rank mirrors the daemon TUI). Transport reality: daemon pushes over WS /ws but CSP forbids ws:, so polling behind a swappable method; push upgrade filed as a follow-up (CSP-widen or daemon SSE). Gate green (vitest 364). Also flipped C04+C02 to done post-merge. Next: C03 (rebase-protocol, independent) or C06/C07/C08 (worktree-join/intervene/bell, need C05 merged — may stack).
- 2026-07-14 — iteration 6: C02 rebrand-lite shipped as glance-desktop#10 (independent of unmerged C04). App presents as Glance — productName/identifier/icon/name-surfaces; deep rename (crate, AI-assistant name, store filenames) deferred to Epic M. Gate green incl. cargo; boots under WSLg. Now 2 cockpit PRs open (C04 #9, C02 #10). Next unblocked: C03 (rebase-protocol, independent) or C05 (needs C04 merged).
- 2026-07-14 — iteration 5 (Lars: "continue now"): C04 fleet-module-skeleton shipped as glance-desktop#9 — the FIRST cockpit-side feature and the first place the two halves of the suite meet. Native `src/modules/fleet/` (FleetClient + keyring token + zustand connection store + FleetPane + palette command + Space persistence + Settings→Fleet). Client state-map VERIFIED against a live daemon's real /api/auth/check responses; CSP confirmed to allow loopback fetch (no Rust). Gate green (tsc/lint/vitest 357/build). Also flipped B01/B02/B03+C01 to done post-merge. Next unblocked: C05 (roster+attention panes, needs C04) — or C02/C03 (rebrand/rebase, independent).

- 2026-07-14 — meta-plan authored; Epics B + C expanded; loop armed.
- 2026-07-14 — iteration 1: B01 osc-attention-emitter shipped as draft PR #177 (suite 2790/0, tsc clean; live-toast check owed). Bonus: fixed a real escape-injection hole in the existing TUI bell. Next: C01 repo bootstrap.
- 2026-07-14 — iteration 2: C01 bootstrap DONE-except-cargo — private repo lmvdz/glance-desktop live (terax @ a2c8329, upstream remote, main pushed), lint/types/vitest(351)/build all green, UPSTREAM.md as glance-desktop#2. OWED (Lars): `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libdbus-1-dev` then cargo re-check. Next: B02 or B03.
- 2026-07-14 — Lars installed the deps → C01 acceptance CLOSED: `cargo check` green (54s), `pnpm tauri dev` mapped a real WSLg window (`xwininfo`: "Tauri App" 800x600). Root cause of the earlier miss was linuxbrew shadowing pkg-config, not the packages. C02–C04 now unblocked once glance-desktop#2 merges.
- 2026-07-14 — iteration 4: B03 harness-hook-reporting shipped as draft PR #179 — reframed from (false) cost gap to LIVENESS, mapped onto presence. Both foreign reviews earned their keep AGAIN: grok found a CRITICAL path-traversal (sessionId→filename) + dead token path; codex found FD-blocking curl, cross-harness id collision, non-atomic config write — 8 findings total, all fixed+pinned, hardened path proven live with a hostile quote-bearing session id. Suite green (1 unrelated flake). **All of Epic B (bridge) now in-review.** Next: Epic C concerns unblock once glance-desktop#2 merges — until then the loop is merge-gated.
- 2026-07-14 — iteration 3: B02 glance-open shipped as draft PR #178. Cross-lineage review earned its keep: grok found first-wins unit ambiguity + untested route guards; codex found TWO grok missed — unvalidated worktree path (relative/dash-leading → editor option; `sh -c` template → code execution) and the spawned editor inheriting the daemon's API keys/tokens. All fixed + test-pinned; live-proved a real spawn carries no secrets. Suite 2797/0. Next: B03 harness-hook-reporting (last unblocked p1).
