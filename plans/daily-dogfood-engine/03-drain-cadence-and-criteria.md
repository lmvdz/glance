# Weekly drain cadence + adoption SUCCESS/KILL criteria

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: plans/daily-driver/00-meta.md (Ledger section, append only), .claude/skills/dogfood-drain/SKILL.md (new)
BLOCKED_BY: 01, 02
MODE: hitl

## Goal

Turn the friction ledger (01) and adoption counters (02) into a repeatable weekly ritual that actually produces fixes and an honest ledger trail — and, at the two-week mark, gives Lars the exact criteria 00-meta.md already committed to, verbatim, so gate review is a sign-off, not a renegotiation.

**Criteria, quoted verbatim from `plans/daily-driver/00-meta.md`** (this concern does not restate or reinterpret them, only carries them forward):

> **Adoption gate.** After epics A–D ship: two weeks of real use, judged by the dogfood counters. Kill criterion: if sustained daily casual use hasn't emerged, STOP — re-diagnose with the friction ledger; epics E–G do not execute and charters H–I do not expand. (Gate sign-off is Lars's, MODE: hitl — `plans/daily-dogfood-engine/03`.)

> The B02 counters (casual sessions/day, prompts/day, push taps/day) are appended to the ledger below weekly. Gate review after 2 weeks of A–D being live. This table is the plan's real success metric — epics shipping green while counters stay zero is the false-green pattern applied to product, and the kill criterion exists to catch exactly that.

And from the arbitration brief (§5, binding): "adopted = sustained daily casual use for 2 weeks; if not after wave 1, STOP and re-diagnose; contingent epics do not start."

## Approach

- **Cadence, documented not automated**: a new `.claude/skills/dogfood-drain/SKILL.md` — invoked manually once a week (or via `/loop 168h /dogfood-drain` if Lars wants the reminder, per the existing `loop` skill's self-paced-interval pattern) — that:
  1. Pulls everything since the last drain: `glance grr --list` (01's ledger) and `glance doctor` / `GET /api/adoption` (02's counters).
  2. Triages each friction-ledger entry into exactly one of three buckets, drafted for Lars's approval, never auto-applied: **fix now** (small enough to just do, cite the file:line), **file as a concern** (append an `NN-concern.md` to whichever `daily-*` sub-plan it belongs to, or a new one if it's out of scope of all six), or **accepted friction** (noted, not actioned — recorded so it doesn't get silently re-triaged every week).
  3. Runs `scripts/append-adoption-ledger.ts` (02) to append the week's counter snapshot to `00-meta.md`'s `## Ledger`.
  4. Appends one line to the same Ledger section summarizing the week's triage (counts only: N fixed, M filed, K accepted) — this is a status line, not a verdict.
- **The skill never writes a SUCCESS/KILL verdict.** That line in the Ledger is written only by Lars, only at the two-week gate review, only by re-reading the accumulated counter snapshots and friction trail and deciding against the criteria quoted above. This is the one hard boundary of this concern: an agent drafting "counters look flat, recommend KILL" as a suggestion for Lars to read is fine; an agent writing "KILL" into the plan doc itself is not — that is the whole reason this concern is MODE: hitl instead of an autonomous loop step.
- If the friction ledger surfaces the same kind of gripe repeatedly (e.g. three gripes about attention/push in one week), that is itself a signal for the needs-you-ladder charter's expansion trigger (`plans/daily-driver/01-charter-needs-you-ladder.md`) — the skill should flag repeat-pattern clusters, not just list raw entries, so that signal doesn't get lost in a flat list.
- Two-week gate review itself is a short synchronous conversation (Lars + whoever's driving), not a document Lars reads alone — the skill's job is to make sure the numbers are ready and legible when that conversation happens, not to replace it.

## Cross-Repo Side Effects

None. Everything this concern touches is inside omp-squad's `plans/` tree and `.claude/skills/`; no runtime code changes, no glance-desktop/cockpit involvement.

## Verify

- Dry run the skill once against real (not seeded) data from 01/02 after they ship — confirm it correctly reads `glance grr --list` and `GET /api/adoption` output shapes, drafts a sane triage, and produces a well-formed Ledger append without corrupting `00-meta.md`.
- Confirm by inspection that no code path in the skill or the append script ever writes the literal strings "SUCCESS" or "KILL" (or equivalent verdict language) into `00-meta.md` — grep for it after a dry run.
- At the actual two-week mark: Lars reviews the accumulated Ledger rows + friction trail and signs off SUCCESS or KILL in his own words, in the plan doc. This concern's STATUS does not move to `done` until that sign-off has happened at least once.
