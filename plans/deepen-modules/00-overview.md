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
