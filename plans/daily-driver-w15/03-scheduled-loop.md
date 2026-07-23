# 03 — Scheduled loop: the drain fires without Lars remembering

STATUS: done — merged in PR #198 (5803a1a); verified on main, 2026-07-21 reality audit
PRIORITY: p1
COMPLEXITY: mechanical
TOUCHES: .claude/skills/dogfood-drain/SKILL.md, plans/daily-driver/00-meta.md, a local scheduled routine (no daemon code)
BLOCKED_BY: — (reads 02's `source` discriminator convention; does not block on it)

## Goal

The weekly drain + adoption-counter snapshot run on a wall clock, not on discipline. A loop that needs Lars to remember will not run.

## Verified constraints (2026-07-17 recon)

- **This is harness-level work, NOT daemon code — by design.** `SKILL.md` explicitly forbids daemon automation of the Ledger ("human-reviewed content"); `src/meta-ledger.ts` (`insertLedgerRow` :47, `assertNoVerdictLanguage` :31) mechanically refuses verdict language. The daemon has NO wall-clock cron (`src/scheduler.ts` is a fleet task queue; the interval timers are operational loops). Do not add one.
- The pieces the routine drives already exist and are manual today: `/dogfood-drain` (drafts the three-bucket triage for Lars's approval), `scripts/append-drain-summary.ts`, `scripts/append-adoption-ledger.ts` (fetches `GET /api/adoption`, appends the counter row).
- The routine must run where the local daemon is reachable (`GET /api/adoption` on the local socket/port) — a cloud-scheduled agent cannot see localhost. Use local scheduling (Claude Code local cron via CronCreate, or an equivalent local mechanism); `/loop 168h /dogfood-drain` inside a long-lived session is the documented fallback, not the primary (it dies with the session).

## Approach

- Create the local weekly routine: fires `/dogfood-drain` every 168h. The scheduled run produces the DRAFT triage + appends the counter snapshot row and triage-summary row (both allowed by the skill; both ride the fail-closed ledger insert). It never writes gate-outcome language — `assertNoVerdictLanguage` enforces this mechanically, and the routine's prompt must restate it.
- The routine's output lands as: ledger rows in `plans/daily-driver/00-meta.md` + a drafted triage Lars reviews. If the daemon is down at fire time, the run records nothing and says so loudly (fail closed, no fabricated zero-counters row — absence of evidence is not a zero).
- `SKILL.md` gains a short "Scheduled operation" section: what the weekly firing does, what stays manual (the verdict), how to pause/resume the routine, and the 02 bucketing note if 02 has landed by then (auto vs human rows in the triage).
- `plans/daily-driver/00-meta.md` Ledger gets one row noting the loop armed (date, cadence, mechanism).

## Verify

- Acceptance: the routine exists and is listed by its scheduler (`CronList` or equivalent) with the right cadence; a manual trigger of the routine end-to-end appends a real counter-snapshot row to 00-meta.md's Ledger against the live daemon (run it once, now — the smoke run IS the proof the wiring works).
- Fail-closed check: with the daemon stopped, a triggered run appends no counter row and reports the failure visibly.
- `assertNoVerdictLanguage` still guards every insert path the routine uses (test exists; confirm it covers the routine's rows).

## Scope boundary

No daemon code. No cloud scheduling. No change to what the drain writes beyond the SKILL.md scheduled-operation section. The adoption-gate verdict line remains Lars's alone — the routine drafts and snapshots, never judges.
