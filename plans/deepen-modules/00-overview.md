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
