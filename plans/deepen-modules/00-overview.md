# deepen-modules — turn the flat 235-file daemon into deep modules, one seam at a time

The repeatable loop Lars asked for (2026-08-03: "we can do this over and over again to clean up
the repo into modules which reduce fatigue and increase codebase understanding"). Each concern is
one architecture-review candidate: a shallow cluster deepened behind a small interface, shipped as
its own reviewable PR with gates at baseline and a blind cross-lineage pass.

Process: `.claude/skills/deepen` (vendored from mattpocock's improve-codebase-architecture +
codebase-design skills, adapted to house practice). Vocabulary: module / interface / seam / depth /
locality / leverage — see the skill. Domain glossary: `CONTEXT.md` (repo root).

Provenance: two reviews on 2026-08-03 — the memory-lane report (two Explore agents; candidates
01–07 here) and an independent fresh-context whole-repo report (candidates 08–13). Re-run the
review phase when this queue runs dry; the codebase will have new hot spots by then.

## Ground rules (learned in iterations 1–3)

- One candidate per PR; mechanical moves and behaviour-bearing extractions in SEPARATE commits.
- Imports carry explicit `.ts` extensions — grep for `name.ts`, not `name` (false zeroes).
- `src/server.ts` (and others) contain NUL bytes: rewrite imports with a Node/Bun script, never sed.
- Boundary enforcement = set-diff allowlist tests (tests/memory-lane-boundary.test.ts is the
  template), never count ratchets — a count lets a removed coupling mask an added one.
- Gate truth: full root suite diffed against the known ratchet baseline; webapp suite; tsc both
  projects. One green targeted run proves nothing (main flakes; see targeted-tests memory).
- Blind grok + codex pass on every diff before it ships; adjudicate findings against the code.

## Iteration 33 (2026-08-04, goal mode)
10 slice 1: RoomSessionCursor — the PR #216 stale-claims wiring is finally table-testable, with
three hardenings (one self-caught: channel-tagged resync). Codex round was humbling and exact:
a CRITICAL TDZ my own misread check-run waved through, the effect-ordering HIGH, and a UX
flicker MEDIUM — all fixed + tested. The layered-verification pattern held: native catch, then
reviewer catches, each finding a different failure class. grok flaked (8/9 today).

## Iteration 34 (2026-08-04, goal mode)
10 slice 2: RoomSession over the transport port — the interleavings themselves are now
scripted tests. SECOND convergent cross-lineage round (grok's TOCTOU HIGH and codex's
render-phase-ref-write M arrived at the same parameterized-markRead fix from different
directions; presence parity found by both). The port pattern is proven: ports-and-adapters
made a React wiring hazard class table-testable.

## Queue pivot (2026-08-03, Lars)

Concerns 14–16 are the CS329A borrows (plans/research-cs329a/BRIEF.md), absorbed into this queue
per Lars: work the borrows before further deepening. Order: 15 (horizon×reliability curve — no
collision with the pending PR train) → 16 (reviewer weights — stacks on src/memory/) → 14
(difficulty-targeted dispatch — BLOCKED until the #310/#311 train merges; touches
squad-manager dispatch). Deepening concerns 05–13 resume after.

## Iteration ledger

- 2026-08-03 — 01 + 02 shipped as PR #310 (src/memory/ + DecisionLedger); grok+codex clean;
  codex live-probed the adopt race. 03 executed same session (same PR, later commits).
- 2026-08-03 — 03 done: src/ledger.ts (4 shapes), six clones → declarations, land-ledger writes
  now atomic+durable; json-parse-as-cast ratchet paid back from +5 to baseline; skills manifest
  gained "deepen". Lesson: a new .claude/skills/ entry fails skills-verify until
  COMMITTED_SKILL_NAMES in scripts/skills-verify.ts lists it.
- 2026-08-03 — 04 slice 1 (feedback lane → src/feedback-lane.ts) shipped as PR #311, stacked on
  #310; suite 4927/2 (pre-existing only); grok + codex both clean (grok byte-verified the payout
  state machine; codex runtime-probed it). REFUTED the review's voice-shell deletion claim —
  those delegations are the RBAC seam; recorded in 04's concern doc. WIP guard: at 3 unmerged
  stacked deepen PRs, the loop pauses for merges.
- 2026-08-03 — 04 slice 2 (capability lane → src/capability-lane.ts, WITH state ownership) on
  PR #311; suite 4928/1 — consolidating the audit catch-handlers paid the error-message-idiom
  ratchet back to baseline (both voice-era overages now repaid by the loop; only dead-exports +1
  workos-provision remains red). grok + codex both clean.
- 2026-08-03 — 04 slice 3 (project lane → src/project-lane.ts: registry + workspace projection +
  ephemeral lifecycle, state owned, fleet behind three read thunks) on PR #311; suite 4927/2
  (dead-exports +1 pre-existing, one isolated-pass ordering flake); grok + codex both clean.
  CS329A borrows joined the queue as 14–16 (Lars's pivot); next firing = 15 horizon curve.
  SquadManager is now ~1,100 lines lighter across the three islands.
- 2026-08-03 — 15 done (continuous mode, no pacing): horizon×reliability curve (src/
  horizon-curve.ts + GET /api/horizon + MondaySurface section). TWO blind rounds each caught
  real statistical dishonesty (codex: non-monotone "up to" + outlier-anchored top band; grok:
  cumulative laundering + sentence/evidence contradiction) — every clause of the final monotone
  band-wise rule is a bought finding with a named regression test. Root 4938/1 (dead-exports
  pre-existing only), webapp 2024/0.
- 2026-08-03 — 16 done (continuous): reviewer ledger (src/memory/reviewer-weights.ts + repo
  JSONL at plans/.reviews/ + scripts/reviewer-ledger.ts closing step, wired into deepen step 7
  and blind-review). Seeded with today's REAL adjudications: codex 9/9 survived, grok 2/2,
  native 0/1 (the voice-shell refutation) — all provisional below the n=10 floor. Codex's four
  findings on the ledger harness itself (duplicate inflation, silent all-malformed, flag-eating
  CLI, output injection) are fixed + regression-tested + recorded as rows. The suite also caught
  my own new JSON.parse-as cast (ratchet works on the ratchet-payer); removed properly.
  WIP GUARD: queue's unblocked work is exhausted until the #310/#311 train merges — loop paused.
