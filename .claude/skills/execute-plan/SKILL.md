---
name: execute-plan
description: Execute a /plan output (or a stack of dependent plans) with the battle-tested multi-agent choreography — adversarial design panel, review-gated implementation batches, cross-batch audit gauntlet, stacked-PR discipline, and workflow crash recovery. Use when the user says "execute the plan(s)", after /plan produces concern files, or to re-run the shape that shipped burr/wave1 (6 executions, 0 regressions shipped).
---

# execute-plan — the choreography that shipped 13/13 concerns clean

Distilled from 6 workflow executions across the Burr and wave1-trust initiatives (240 subagent transcripts mined). The verbatim battle-tested scripts live in `references/` — adapt their constants, keep their structure.

## Phase 0 — re-baseline (skipped once, cost a session)

Main moves while plans sit. Before executing: `git merge origin/main` into the working branch, capture the green baseline (**test count + SHA**) before any implementer runs, and fan out cheap anchor-verify explorers — one per file cluster — reporting `cited → actual | MATCH/DRIFT` for every file:line anchor in the concern docs. Correct drifted anchors in the docs; locate by SYMBOL, not line. Both mined initiatives hit stale anchors; one design carried a stale 112-commit-drift premise that an arbiter had to overturn empirically.

## Phase 1 — adversarial design panel (when concerns aren't yet decomposed)

See `references/adversarial-design-panel.workflow.js`. Shape: 1 designer (reads brief + live source, drafts 2–3 approaches) → 2 parallel red-teamers with **complementary attack mandates** (concurrency/crash-windows/persistence vs. wrong-assumptions/migration/simpler-alternatives/scope-creep), every finding cites file:line → arbiter rules on each finding (schema: `redTeamResolutions[{concern,severity,resolution}]`; `openQuestions` empty unless user-only), may Read source to settle disputes → decomposer emits schema-validated concern files with verified anchors. The red teams found real killers both times ("flagship breaks day one", the landFeature bypass).

## Phase 2 — gated implementation batches

See `references/gated-execute.workflow.js`. Per concern/batch:

1. Implementer (sonnet) with IMPL_SCHEMA — `status: done|blocked|already-done`, `commits`, `anomalies`. Prompt rule: **REPORT anomalies, don't force through them.** Thread an accumulated `prior` summary of earlier batches' changes into every prompt — later concerns build on the "new world" (e.g. "all status writes must route through transition() or the enforcement test fails").
2. Review gate (fable) with REVIEW_SCHEMA — `pass=true` only with zero critical/significant findings, and it reads the actual `git show`, **never the implementer's report** (a fixer once caught three commit messages overclaiming their fixes — verify diffs, not messages).
3. Fail → fixer → re-review; still failing → **abort the run**, don't limp on.
4. Schema hygiene: put `maxLength` caps on every string field — a verbose agent once blew the StructuredOutput retry cap (5) and killed a whole workflow mid-run.

## Phase 3 — audit gauntlet (before any PR)

Run in parallel: `/code-review high` scoped to the plan's diff range AND a cross-batch auditor (fable) checking inter-concern composition — wiring completeness ("dto.subagents flows to webapp and no component renders it"), persisted-shape upgrade paths, sibling-plan collisions, goal-completion vs DESIGN.md. **The two passes find different bugs every time** (5/5 runs): the auditor catches dead wiring and honesty gaps; code-review catches things like cross-tenant cache leaks. Consolidate → split fixers by disjoint file sets ("do NOT commit — orchestrator commits") → fable re-review of fix commits only with targeted regression probes → SHIP verdict → flip STATUS lines → push → draft PR.

**Then `/blind-review` the fix commits, before the SHIP verdict.** A reviewer that inherits your framing inherits your blind spots, and by this point every reviewer has: the concern docs, the implementer's claims, your fix-list, your known-accepted minors. Spawn one agent — foreign lineage where possible — with the diff, the system's invariants, and nothing else. On the eap-borrows run all four briefed gates passed a diff in which the orchestrator's own fix-list had caused a fail-open (`land-risk` returning "safe" for an *unknowable* blast radius), a fixer had introduced a permanent branch park, and retryable refusals had no bounded escalation at all — the interlock shape. The native re-verifier, asked "is the hole closed?", said SHIP. Nobody had asked **what the fix opened**. When the blind pass and a briefed pass disagree, adjudicate against the code and expect the blind one to be right; do not tally votes.

## Stacked plans (N dependent plans)

Branch `feat/A` from main, `feat/B` from A, etc. Scope each plan's reviews/audits to `base..HEAD` so lower plans aren't re-reviewed. Open stacked draft PRs with explicit bases and state the merge order. **Merge-time rule: after each parent merges, retarget the child's base to main before merging it** — this repo's PRs #27/#34/#35 were merged into their parent branches and never reached main (see `/land-sweep`). Deleting merged branches promptly makes GitHub auto-retarget children.

## Workflow crash recovery

A dead workflow ≠ lost work — implementers commit before they report. Don't rerun blind: inventory `git log` for orphaned commits, dispatch a reviewer at the orphaned commit focused on half-done-work risk, then relaunch a **trimmed** workflow covering only the remaining concerns with the accumulated context carried forward (resumeFromRunId when the script is unchanged; hand-trimmed script otherwise).

## Standing prompt boilerplate (every fan-out agent)

- rtk mangles bash grep/git output — use Read/Grep tools or `rtk proxy`; treat null results as suspect.
- Run gates from the REPO ROOT with absolute paths (`cd plans/<x>/` left behind has silently broken full-suite runs twice).
- `PATH="$PWD/node_modules/.bin:$PATH" bun test`; the 2 WSL spawn flakes are pre-existing — prove against baseline, don't chase.
- Big reports: write to a file, return a pointer + summary (task-notification truncation has eaten findings ≥4 times).
- **Implementers run TARGETED tests only. The review gate owns the single full-suite run.** A subagent that backgrounds a 4-minute suite pauses, gets resumed with no memory of waiting, and must be nudged — this happened to 5 agents in one session, several suites contending for the same cores. If an implementer must run the full suite, tell it to run in the FOREGROUND and say why: *"you will be resumed with no memory of waiting."*
- **A pre-existing flake is a claim, not a fact.** When an agent reports "unrelated failure, pre-existing," verify it: confirm the file is untouched by the diff (`git show --stat`), run it in isolation, and check whether a second, independent agent hit the same thing. Two of this repo's real bugs first appeared as "unrelated."
