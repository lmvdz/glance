---
name: reality-audit
description: Three-way truth reconciliation of plans/ STATUS lines × Plane tickets × what the code on main actually contains — with adversarial verification of every "done" claim. Use when the user asks "what's really done", "audit the plans against reality", suspects false-Done tickets, or before starting a new initiative on top of claimed-finished work.
---

# reality-audit — trust code, not STATUS lines

Every status store in this project has lied at least once (mined evidence): plans said `open` for shipped work and `done` for stranded work; Plane issues sat Done while their fix never reached `main` (OMPSQ-306/309/310); memory claimed "shipped on PR #26" for commits that were never pushed. The only ground truth is the code on `origin/main`. `/sync-plans` copies Plane→STATUS and `/wip` counts STATUS lines — neither verifies against code. This skill is the lie detector.

## Shape

1. **Inventory.** Enumerate `plans/*/` concern docs (STATUS/PLANE pointers) and Plane modules/tickets. Build the linkage matrix; note drift in both directions (concerns with no ticket, tickets with no concern, plans with zero Plane representation).
2. **Fan out one auditor per plan** (parallel subagents). Each reads the concern's TOUCHES/acceptance criteria, then checks **main's actual code**: does the promised symbol/file/behavior exist (`git log -S`, `git ls-tree origin/main <file>`, read the source)? Verdict per concern: REAL / PARTIAL / DEAD / LYING, with file:line evidence. Prompt must include the rtk warning (use Read/Grep tools, distrust null bash-grep results).
3. **Adversarial verify.** A second pass re-checks every done/partial claim against the cited evidence (the one prior run of this caught 1/80 refuted — cheap insurance that keeps the report honest).
4. **Reconcile.**
   - Rewrite STATUS lines to match code (with a one-line why on each flip).
   - Reopen false-Done Plane issues; retro-file tickets for implemented-but-untracked work; backfill `PLANE:` pointers and missing `blocked_by` relations (missing relations let the fleet race its own DAG).
   - Emit a ranked drift table: which store lied, in which direction, and the systemic cause if visible.
5. **Optionally chain** into clean-slate triage: cross-reference into a keep/done/cancel/archive disposition table, get user sign-off on the kill list, then mass-execute via Plane REST (gotcha: the base URL already ends in `/api/v1` — don't double it) and re-query to verify final counts.

## Rules

- A green test suite is not evidence a *feature* works — this repo has canned endpoints and stubbed subsystems (see `/make-it-work`). Cite code, or drive the running system.
- "Done" requires the change on `origin/main`, not on a branch, not in a worktree, not in a MERGED-but-wrong-base PR (see `/land-sweep` for that failure class).
- Date-stamp the audit and store the verdict table in the plan dir or memory — the 2026-06-30 audit had to be re-derived by hand two days later because only its conclusions survived.
