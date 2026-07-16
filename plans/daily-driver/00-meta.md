# Daily driver — meta-plan

STATUS: open
PRIORITY: p0
REPOS: omp-squad (glance-desktop only via the ladder charter, later)
COMPLEXITY: architectural

## North star

Glance becomes the thing its builder picks up mid-thought — `glance here` in any terminal beats typing `claude` because it carries the same brain **plus** things the terminal can't do: a phone buzz when the long task finishes, edits that appear in the real checkout without racing it, a checkpoint behind every turn, and one command to promote a chat into a gated, landable unit. Evidence and design bar: `plans/research-t3code/BRIEF.md` (the seven daily-dogfood laws); arbitrated design: `DESIGN.md` here.

The strategy is not features — it is starting the dogfood loop. t3code's polish stream (~25 lived-in fixes/week) exists because its builder lives in it. Wave 1 ships the on-ramp *and* the friction-capture engine; everything after wave 1 executes only on adoption evidence.

## Standing requirements (Lars, 2026-07-15, at execution start)

1. **It needs to work.** Every concern's Verify is executed by driving the real system live (scratch-daemon + real agent + real browser for push). Green tests alone never count as done.
2. **User experience.** Taste ≥ 7 on every user-facing surface (CLI output, terminal REPL, webapp, push copy): fable/opus authors or reviews every UX-critical diff; webapp work loads frontend-design-guidelines; "feels instant and obvious" is an acceptance criterion, not a nice-to-have.

## Decisions (locked unless Lars overrides)

- **OMPSQ-40 stays law.** Casual sessions run in standard worktrees. Visibility comes from one-directional boundary sync: each finished turn's patch applies to the real checkout iff the real tree is unchanged since turn start; otherwise hold + attention item. True in-place is a charter (below), not a wave-1 feature.
- **Terminal-first.** `glance here` attaches in the current terminal; the webapp is a printed URL / `--web` flag riding the existing token mechanism. No new auth surface in wave 1.
- **Casual sessions ride the claude harness on the operator's own login/config**, parity-verified — never a less-configured brain than the incumbent.
- **Wave-0 push before any ladder.** Completion/needs-input push for casual sessions generalizes the shipped voice-done latch. The full needs-you ladder is a charter gated on friction evidence.
- **Fail-closed everywhere.** Four fail-open instances found in design review (checkpoint capture failure, daemon absence mid-turn, await timeout, missed events after restart) — each is a fail-closed acceptance test in its concern. Absence of evidence is never evidence of settlement.
- **Adoption gate.** After epics A–D ship: two weeks of real use, judged by the dogfood counters. Kill criterion: if sustained daily casual use hasn't emerged, STOP — re-diagnose with the friction ledger; epics E–G do not execute and charters H–I do not expand. (Gate sign-off is Lars's, MODE: hitl — `plans/daily-dogfood-engine/03`.)
- **Model routing** per CLAUDE.md: judgment = fable (opus fallback); implementation = sonnet; mechanical isolated diffs = codex; wide sweeps + third-lineage review = grok. Cross-lineage review (codex AND grok) mandatory on: boundary sync (git-write path), preview tool (SSRF), any auth-surface touch.
- **Merge policy**: draft PRs only; Lars merges.

## Epics

| Epic | What it delivers | Sub-plan | Adoption path? | Status |
|---|---|---|---|---|
| A | `glance here`: terminal thread on cwd, claude parity, boundary sync, restart re-attach, web flow, promote/adopt UI | plans/daily-onramp/ | YES — wave 1 | expanded, open |
| B | Dogfood engine: `glance grr` friction ledger, adoption counters, weekly drain + kill criteria | plans/daily-dogfood-engine/ | YES — wave 1 | expanded, open |
| C | Attention wave-0: casual completion/needs-input phone push; transition-event subscription refactor | plans/daily-attention-w0/ | YES — wave 1 | expanded, open |
| D | Composer sanctity: draft persistence + crash flush; mid-turn send-semantics verification; reasoning-first delta (contingent) | plans/daily-composer/ | YES — wave 1 | expanded, open |
| E | Turn substrate: quiesce events (fail-closed), per-turn checkpoint refs, non-destructive restore, orphan sweep | plans/daily-turn-substrate/ | no — fleet value, post-wave-1 | expanded, open (p2) |
| F | Preview host-tool for driven agents (agent-browser adapter, SSRF-specced) | plans/daily-preview-tool/ | no — fleet value, post-wave-1 | expanded, open (p2) |
| G | Overhead: mock-harness deterministic ratchet + published live ratio (never a gate) | plans/daily-overhead/ | no — post-wave-1 (stopwatch is A01, wave 0) | expanded, open (p2) |
| H | Needs-you attention ladder (full) | charter: 01-charter-needs-you-ladder.md | contingent | charter only |
| I | True in-place sessions | charter: 02-charter-true-in-place.md | contingent | charter only |

## Dependency graph

- A01 (stopwatch) first — wave 0, informs A02's prewarm decision. A02 → A03; A02 → A04/A05/A06.
- B, C, D are parallel to A and to each other (disjoint TOUCHES; C01 and A05 both read push paths but touch disjoint files).
- E, F, G: independent, p2, sequenced after wave 1 by priority not by BLOCKED_BY.
- H expands only on B03 evidence (attention pain in the friction ledger) or a committed cockpit consumer. I expands only after A03 has soaked ≥2 weeks in daily use AND E02's fail-closed checkpoint machinery exists; its prerequisites are spelled in the charter.

## Adoption gate & counters

The B02 counters (casual sessions/day, prompts/day, push taps/day) are appended to the ledger below weekly. Gate review after 2 weeks of A–D being live. This table is the plan's real success metric — epics shipping green while counters stay zero is the false-green pattern applied to product, and the kill criterion exists to catch exactly that.

## Not yet specified

- (none — parked questions live in the two charters with written expansion triggers)

## Out of scope

- Shadow-adopt continuous snapshot — redundant with pre-turn refs; adopt's guards would refuse it anyway — see DESIGN.md
- Queue-not-block composer machinery — current send-through may be better; verify first (D02) before building
- xterm/PTY terminal in the webapp — local user has a local terminal; security surface buys nothing here
- Mobile app / multi-machine relay — future program once the local loop is proven
- Multi-instance harness registry + continuationIdentity — fold into the next driver-seam touch
- Convention-lint-for-agents — own small plan against ratchet/gauntlet docs
- Event-sourced decider/projector rewrite — lifecycle-truth substrate already suffices
- Full-access-by-default permissions — t3code anti-pattern, rejected

## Decisions so far

- (ledger of concern closures appends here)

## Notes

- Phase-0 WIP snapshot: proceeded over existing open plans (meta-autonomous-fleet 37 open, phase0-sandbox-hardening 11, flow-marketplace 9, adw-factory-borrows 9, fleet-ide-cockpit 7 stale) — Lars chose "proceed" at the gate, 2026-07-15.
- Design provenance: draft by sonnet designer; red teams fable×2 (safety, adoption); arbitration fable. Both red-team critiques materially changed the design (see DESIGN.md tables); the draft's in-place recommendation was overturned on evidence.

## Shared-file discipline

`src/server.ts` and `src/squad-manager.ts` are touched by concerns in epics A, C, and E. Within an epic, overviews already sequence same-file concerns. Across epics: execute wave-1 epics (A–D) before p2 epics (E–G) touch those files; inside wave 1, land A02 before C01/C02 (both edit server push/console paths), or accept ordinary rebase discipline — every concern executes in its own worktree and lands via a proven merge regardless.

## Ledger

- 2026-07-15 — meta-plan authored; epics A–G expanded, charters H–I written; awaiting Lars's decomposition sign-off and optional /plan-to-plane filing.
- 2026-07-15 — decomposition complete: 7 sub-plans, 24 concerns, 2 charters, 29 files. Writers surfaced 4 material facts during authoring: (1) `claude-code` harness is `verified:false`, ACP, refuses nested sessions — A02 now includes the verified-flip smoke (grok #147 precedent); (2) webapp Composer is mounted unkeyed by session — draft leaks across threads today; D01 fixes keying + persistence together; (3) today's `lastStatus` diff in maybePushAlert *accidentally* suppresses a boot-time push flood — C02 carries a required regression test so the refactor doesn't ship the flood; (4) presence data has no HTTP route — A06 scopes a minimal `GET /api/presence`.
- 2026-07-16 — run 1 SHIPPED+LIVE: A01 stopwatch (cold 7730ms / warm 6262ms; prewarm = overlap-spawn-with-typing + one-per-project pool) and A02 `glance here` (7 commits incl. claude-code verified-flip after live ACP smoke v0.16.2). Functional gate passed, UX gate passed, live verify worked=true (real claude turn in tmux pty, /proc-proven CLAUDECODE scrub, ephemeral lifecycle held across 5 sessions). Standing gaps: claude-adapter warm start 8.3–11s reply-visible (adapter spawn +1.3–1.5s vs omp); daemon shutdown orphans ACP adapter chains (investigate: intentional webapp-continuation or reap?); auto-memory parity FAIL documented in 02's Resolution.
- 2026-07-16 — D02 midturn-send-semantics DONE (live drive, 4 scenarios + 4 controls, scratch daemon + real claude-code agent). Verdict: KEEP SEND-THROUGH — the adapter already serializes mid-turn sends losslessly (nothing lost even at 3 rapid-fire sends; tool-call windows fold the new message into the SAME turn — better than t3code's queue) and no queue machinery gets built ("Out of scope" entry stands, now evidence-backed). Spawned: plans/daily-onramp/07 (p0 SHIP-BLOCKER, independent of composer semantics — AcpAgentDriver's 60s `session/prompt` timeout errors ANY >60s claude-code turn; proven with a clean 75s turn) and plans/daily-composer/04 (p2 honesty repairs: orphaned permanently-"running" entries on mid-generation sends; DTO idle while queued turns still stream). Steer constraint holds vacuously; recorded fact: an ACP "steer" today cannot redirect an in-flight turn — it's a queued follow-up, FIFO with chat.
- 2026-07-16 — B03 drain machinery SHIPPED (live-verified, scratch daemon): `.claude/skills/dogfood-drain` weekly ritual + `scripts/append-drain-summary.ts`, both riding `src/meta-ledger.ts`'s single fail-closed Ledger insert, which mechanically refuses gate-outcome language — the sign-off line below stays Lars's alone at the two-week review. Gate criteria carried verbatim in the skill; weekly rows land in this section from here on. Concern 03 sits in-review until that first sign-off.
- 2026-07-16 — **Integrated live verification (wave 1)**: all six flows driven end-to-end on a throwaway repo (scratch daemon, real claude-code turns, real browser) — PASS on all six. (1) `glance here` cold+warm PASS: cold ready 5.7s / warm 4.7s, real turns streamed back ("pong", "42"). (2) Boundary sync happy path PASS: two clean turns applied straight to the real checkout (`notes.txt` gained each turn's line with the real tree provably untouched mid-turn), no attention row raised. (3) Boundary sync held path PASS: a concurrent operator edit during a turn held the patch (`source:"boundary-sync"`, `sync:"held"`, real tree left with only the operator's own edit), `POST .../apply-held-sync` re-checked and landed the patch cleanly (`{"ok":true,"applied":1,"remaining":0}`) once the fork point matched; `discard-held-sync` also exercised successfully. (4) Completion push PASS-with-gap: a real Chrome `PushManager` subscription (genuine FCM endpoint) plus `POST /api/push/subscribe` succeeded; the server's actual `PushService.notify` path (duration gate honored via `OMP_SQUAD_PUSH_MIN_TURN_MS=500`) got a real HTTP 201 from `fcm.googleapis.com`; the `?push=1` deep link correctly beaconed `POST /api/push-tap` and stripped the marker — the one unprovable leg is on-device delivery, since this sandbox's headless Chrome-for-Testing has no live FCM receive channel. (5) Restart re-attach PASS: daemon killed mid-attached `here` session, restarted from the same state dir; the still-running REPL detected the dead session, printed the honest "did not survive a daemon restart... no detached host to reattach... would fake a resume" reason and the "⟲ session restarted" marker, created a fresh session with recovered context riding the operator's NEXT prompt (never auto-sent) — verified live by asking the new session to recall the prior turn's word and getting the correct answer back. (6) Draft persistence PASS: typed composer text (real webapp via agent-browser) persisted to `localStorage` keyed by session id, survived a hard reload, and switching threads via the actual roster-row control showed each thread's own draft with zero leakage either direction (an earlier apparent leak was a test-methodology artifact — editing the URL hash directly drives a *different* surface, `AssistantChat`/`openConsole`, not `WorkspaceCockpit`'s own selection — not a product bug). Environment finding worth carrying forward: `@oh-my-pi/pi-tui`'s import performs its own dotenv-style env load with override semantics from CWD, silently flipping `DATABASE_URL`/WorkOS creds back on from the repo's real `.env` even with an explicit empty shell export AND `bun --no-env-file` — file mode only held once the daemon was launched from a cwd with no `.env` present. Boundary-sync STATUS flips to done below (flows 2–3 both passed).
