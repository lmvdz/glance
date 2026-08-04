---
name: deepen
description: One iteration of the deepen-modules loop — pick the next architecture candidate from plans/deepen-modules/, deepen the shallow cluster behind a small interface in an isolated worktree, hold gates at baseline, blind cross-lineage review, ship a draft PR, update the queue. Use when the user says "/deepen", "run a deepen iteration", "next module cleanup", or "keep modularizing". Re-runs the review phase when the queue is dry.
---

# Deepen — one module-deepening iteration

The loop (provenance in `PROVENANCE.md`): review finds shallow clusters → each becomes a concern
in `plans/deepen-modules/` → one iteration deepens one concern behind a small interface → gates +
blind review → draft PR → queue updated.

## Vocabulary (use these words exactly)

Ousterhout terms — module, interface, deep/shallow, seam, leverage, locality — carry their
standard meanings. The two house rules on top: *one adapter is a hypothetical seam, two adapters
is a real one*, and **the deletion test** — delete the module; if complexity reappears across N
callers it earned its keep, if it just vanishes it was a pass-through. Never substitute:
component, service, API, boundary, wrapper. Domain nouns come from `CONTEXT.md` — extend it when
a deepened module names a concept it lacks.

## The iteration

1. **Select.** Read `plans/deepen-modules/00-overview.md` + the concern files. Pick the
   highest-priority OPEN concern that is unblocked (respect MODE: needs-design / needs-lars —
   those stop for a human). Flip it to `STATUS: in-progress`.
2. **Isolate.** EnterWorktree. **Check the base FIRST: if origin/main is behind local main,
   ff-merge local main in (`git merge --ff-only <local-main-sha>`) — building on a stale base
   collides with unpushed work and has cost a whole iteration.** Then
   `bun install --frozen-lockfile` (root AND webapp/) — the node_modules skew memory.
3. **Read before writing.** Read every file the concern touches, in full, at the current SHA.
   The concern doc's line numbers rot; the semantics you must preserve live in the doc comments —
   they encode incident history (blind-review findings, production incidents). Moved code keeps
   its comments.
4. **Design the seam.** Small interface, dependencies accepted not created, the second adapter
   identified before writing (usually: production + a bare in-memory test adapter). Mechanical
   moves and behaviour-bearing extractions go in SEPARATE commits — a reviewer must be able to
   verify "pure move" by inspection.
5. **House traps** (each cost a real session real time):
   - Imports carry explicit `.ts` extensions — grep `name.ts`; bare-name greps return false zeroes.
   - `src/server.ts` and others contain NUL bytes: rewrite imports with a Bun script reading/
     writing utf8, never sed/grep pipelines; use Read/`ugrep` to inspect.
   - Boundary enforcement = set-diff allowlist test with a ratchet-down twin
     (tests/memory-lane-boundary.test.ts is the template) — never a count ratchet.
   - New barrels: explicit named re-exports (`export *` silently drops duplicate names).
   - Watch the dead-exports ratchet: every new export needs a caller outside its file, or
     `@substrate <reason>`.
6. **Gate at baseline, not at green.** `bun run check` (both tsconfigs). Webapp suite. FULL root
   suite (background it; it has OOM'd), then DIFF the failure set against the known pre-existing
   baseline (HANDOFF.md / the wave-0 memory: ratchet trio fails everywhere; two more failures
   appear only when `.env` is present). New failure = your defect until proven otherwise. A green
   targeted run proves nothing.
7. **Blind cross-lineage review.** grok AND codex, zero framing ("review this diff, hunt real
   defects"), read-only sandboxes, on the full diff. Adjudicate findings against the code — a
   finding is a hypothesis. This pairing has caught ship-blockers on every git-write/concurrency
   path it ever reviewed; a clean bill from both is signal, not formality.
   **Close by recording every ADJUDICATED finding** in the reviewer ledger (Weaver-lite,
   concern 16): `bun scripts/reviewer-ledger.ts add --lineage <grok|codex|native> --class
   <kebab-tag> --survived <true|false> --source "<PR/diff>" --note "<one line>"` — clean bills
   are not rows; a refuted claim IS a row (survived=false), whichever review raised it. Then
   `bun scripts/reviewer-ledger.ts report` to see the measured per-lineage precision.
8. **Ship.** Commit(s) with teaching bodies (what moved, what the seam is, what was verified,
   what was deliberately left). Push branch, draft PR — never push main, never merge. PR body
   names the concern and the deliberately-left follow-ups.
9. **Close the loop.** Flip the concern to `STATUS: done` with PR + commit SHAs. Append one line
   to 00-overview.md's iteration ledger. If this iteration exposed a NEW shallow cluster, add it
   as a new concern file rather than widening this PR.

## When the queue is dry

Re-run the review phase: spawn Explore agents over the current hot spots (`git log --oneline -300
--name-only` histogram), present candidates as an HTML report (Tailwind+Mermaid CDN, before/after
diagram per candidate, Strong/Worth-exploring/Speculative badges, top recommendation), let Lars
pick, then append the picks as new concern files. The codebase grows new hot spots faster than
this queue drains.
