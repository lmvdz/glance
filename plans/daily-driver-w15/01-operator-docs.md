# 01 — Operator docs: the daily-driver manual

STATUS: done — merged in PR #198 (5803a1a); verified on main, 2026-07-21 reality audit
PRIORITY: p1
COMPLEXITY: mechanical
TOUCHES: README.md, docs/daily-driver.md (new)
BLOCKED_BY: 02, 03, 04 (sequenced last in-batch so the doc covers the new surfaces; no hard blocker)

## Goal

A human who has never read the plans can discover and use every daily-driver feature from the docs alone. "You can't dogfood what you can't remember how to invoke."

## What exists to document (anchors re-verified 2026-07-17)

- `glance here` on-ramp: cold/warm start, `--web` flag, restart re-attach behavior (honest "session restarted" marker, prior context rides the next prompt). CLI dispatch in `src/index.ts`.
- Friction capture: `glance grr "<gripe>"` (dispatch `src/index.ts:1291`, POSTs `/api/friction`), `glance grr --list [--json]`, and the webapp composer grr popover (`webapp/src/components/chat/Composer.tsx`).
- Boundary sync semantics: clean-turn auto-apply, held syncs (`sync:"held"` attention rows), recovery via `POST /api/agents/:id/apply-held-sync` / `discard-held-sync`, orphan discovery via `GET /api/boundary-sync/orphaned`.
- Completion push: subscription flow, `OMP_SQUAD_PUSH_MIN_TURN_MS` duration gate, `?push=1` tap beacon.
- Adoption counters: `GET /api/adoption` — IMPORTANT: counters are **derived at read-time** from `receipts/*.jsonl`, `transitions.jsonl`, `push-taps.jsonl` (`src/adoption-counters.ts:237`); there is no counter state to reset or lose.
- The weekly drain ritual: `/dogfood-drain` (skill), `scripts/append-drain-summary.ts`, `scripts/append-adoption-ledger.ts`, and the fail-closed meta-ledger discipline (verdict language refused mechanically; SUCCESS/KILL is Lars's line alone).
- The new wave-1.5 surfaces from concerns 02/03/04 (auto-captured friction + its `source` bucketing, the scheduled drain loop, the webapp Daily panel) — document them as built, not as planned.

## Approach

- New `docs/daily-driver.md`: task-oriented ("start a session", "capture friction", "recover a held sync", "read your adoption numbers", "the weekly drain"), one command block per task, honest caveats included (e.g. on-device push delivery unprovable headless). Cross-link `docs/self-drive.md` for the automation panel.
- `README.md`: one subsection pointer under `## The dashboards` (line ~112) and a list entry under `## Documentation` (line ~240). Do not bloat the README — the manual lives in docs/.
- Every command and route named in the doc must be copy-paste runnable against a live daemon.

## Verify

- Acceptance: every command/route/env-var in the doc exists in code at the cited form — checked by actually running the CLI commands (`glance grr --list`, `glance here --help`) against the worktree build.
- Docs style: prose, no emoji ledgers, matches existing docs/ tone. Taste bar applies (meta-plan standing requirement 2) — this is user-facing copy.
- Gate: full-suite untouched (docs-only diff apart from README), links resolve (relative paths exist).

## Scope boundary

No new features, no webapp "start here" affordance (deferred by overview), no restructuring of existing docs/ files beyond the two README insertion points.
