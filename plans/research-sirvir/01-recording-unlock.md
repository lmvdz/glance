# Fix land-outcome recording — the unlock

STATUS: in-review
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: src/squad-manager.ts, src/model-outcomes.ts

## Goal
Make land-outcome recording actually populate `model-outcomes.json` (and its siblings `land-ledger.json`, `threshold-tuner.json`) on a live land, proven with a non-empty, correctly-keyed ledger. This is the precondition for every other GOAL-1 concern: they read a ledger that today has never been written.

## Evidence it's broken
On the live install `~/.glance` (372 receipts, active fleet): `dispatch-ledger.json` exists but `model-outcomes.json`, `land-ledger.json`, `threshold-tuner.json` are ALL absent at root AND under `orgs/*/`. `land-failures.json` has many entries (squad/ompsq-55, -130, -138, -189, -178, …). The record branch `squad-manager.ts:2488` (`if (!result.retryable && (auto || result.ok)) { recordLandOutcome(...); recordModelOutcome(...); }`) has never fired on this install.

## Approach
Two stacked root causes — resolve BOTH; either alone is sufficient to keep the ledger empty.

**(A) Stale daemon binary.** The recording code landed on `origin/main` only 2026-07-06 (`0ab1fff` Epic 6 concern 06, `199f291` scoreboard). The daemon runs the global install (project memory: "daemon runs the GLOBAL install, restart to pick up"), which likely predates it.
- 30s check: confirm the running daemon's build vs `0ab1fff`. Rebuild/reinstall the global `omp-squad`, `squadctl restart` (ensure `~/.bun/bin` on PATH — memory gotcha), then drive a clean land and check `ls -la ~/.glance/model-outcomes.json`.
- If it appears after restart → (A) was the cause; document it and move to verifying keys (concern 02).

**(B) Retryable-failure starves recording.** Even on current code, the branch is gated `!result.retryable`. The comment at :2485 confirms a dirty-main checkout is classified *retryable* ("environmental precondition, not a branch failure"). If the dominant live failure mode is retryable dirty-main (it is — this is the OMPSQ-417..423 "units never commit / dirty main" problem), the branch is skipped and NO outcome — success or failure — is recorded. A fleet that rarely reaches a clean confirm produces zero learning signal.
- Decide the fix: EITHER (i) record a distinct outcome for retryable/blocked lands (a third state, so the ledger reflects "attempted, couldn't land cleanly" rather than silence) — but weigh whether that pollutes land-rate as a model-quality signal (a dirty main isn't the model's fault); OR (ii) treat (B) as out of scope for *this* concern and instead ensure that when clean lands DO happen they record, accepting sparse data until landing reliability improves. Recommended: (ii) for this concern + a one-line note that (i)/landing-reliability is the real volume unlock, cross-referencing the dirty-main work. Do NOT silently fold dirty-main land repair into this concern — that's a separate, larger effort.

**Stop condition:** if after (A) a restart still yields an empty ledger AND (B) shows lands essentially never reach a clean confirm, then landing itself is the bottleneck — REPORT that up (it blocks concern 05's premise) rather than forcing a recording change that will still have no data to record.

## Cross-Repo Side Effects
None (single repo). Concerns 02/04/05 depend on this producing real data.

## Verify
Drive a real clean land through the daemon (or a scripted land of a trivial branch). Assert `~/.glance/model-outcomes.json` (or the org-scoped path) exists and contains at least one `${model}::${tier}` key with a non-zero count. Capture the file contents as evidence in the Resolution.

## Resolution (root cause FOUND — 2026-07-07)
**Not a stale daemon, not a recording-code bug. The fleet cannot land because the main checkout is persistently dirty, and recording is coupled to a clean land.**

Verified:
- Daemon started 2026-07-07 12:17:09 on `/home/lars/sui/omp-squad/src/index.ts` (main `c25cdab`); local main HAS `recordModelOutcome` (grep = 2). The running binary has the recording code — cause (A) stale-daemon is **ruled out**.
- `git -C /home/lars/sui/omp-squad status --porcelain -uno` = **113 tracked changes** right now (the `webapp-legacy/` deletion pile + `.gitignore` mod + `plan.md` deletion), uncommitted directly on main.
- `land-failures.json`: 5 of 10 branches are the RETRYABLE refusal `"main checkout … has uncommitted tracked changes — refusing to land"` (ompsq-55/-178/-189/-190/-194, each `fails:3`). The land branch `squad-manager.ts:2488` gates recording on `!result.retryable` → a dirty-main refusal is retryable → the record branch (both `recordLandOutcome` and `recordModelOutcome`) is skipped. Hence all three learning ledgers are empty. This is cause **(B)**, live and dominant.
- (The other 5 failures — reviewer-reject/verify-fail/git-add-fail on 130/138/211/294/landing — are non-retryable and predate the current daemon; they'd record if they recurred post-restart, but the persistent dirty main blocks fresh lands from ever reaching them.)

### Two-part fix
1. **Immediate unblock (needs the user's call — their uncommitted work):** clean the main checkout's 113 tracked changes (commit the `webapp-legacy` removal as an intentional cleanup, or stash/revert). Cannot be done unilaterally — it's the user's working tree. Until it's clean, EVERY auto-land is refused and no recording is possible.
2. **Durable code fix (this concern, after unblock):** the model-outcome statistic is documented "cheap, always-on … data on day one" (`squad-manager.ts:2490`) but is in practice gated behind `!result.retryable` — so a dirty-main-blocked fleet is invisibly starved of ALL learning signal. Decouple the always-on statistic from the retryable land gate (record the attempt/outcome even when the land is refused for an environmental precondition), AND/OR make "landing blocked by dirty main" a loud, surfaced state rather than silent accumulation in `land-failures.json`.

**Stop-and-reassess (per 00-overview Notes):** landing itself is the bottleneck. Concern 05 (fleet routing) is premature until lands complete and the ledger populates. Recommend: unblock main → drive a clean land → verify a non-empty `model-outcomes.json` → THEN resume 02→04→05. Concern 06 (GOAL 2) is independent and unaffected.

## Resolution addendum — part 2 SHIPPED (2026-07-07, feat/sirvir-01-recording-decouple)
Part 1 (dirty main) resolved separately: PR #103 landed the `webapp-legacy` cleanup, main is clean. Part 2 (durable code fix) implemented as BOTH halves of the two-part fix:

1. **Decoupled statistic — a distinct third state, not a landed/rejected pollutant.** `land()`'s record branch (`squad-manager.ts`, `if (!result.retryable && (auto || result.ok))`) gained an `else if (result.retryable)` arm that records the attempt via new `recordModelOutcomeBlocked()` (`model-outcomes.ts`): `ModelOutcomeCounts` gains an OPTIONAL `blocked` counter, bumped only for retryable/environmental refusals. `landed`/`rejected` are never touched by it — a dirty main isn't the model's fault, so the land-rate signal smart-spawn/attribution-scoreboard/cost-gate read is bit-for-bit unchanged. On-disk backward-compatible: old `model-outcomes.json` files parse as-is (`blocked` absent ⇒ absent, never defaulted in), verified by test.
2. **Loud surfaced state.** Every retryable refusal now fires a warn-level automation event on a new event-driven `"land"` channel (`fileLandBlockedFinding`, mirrors `fileScopeFinding`; new `dirty-main` `AutomationSkipReason` tags the dominant cause) — persisted to `automation.jsonl`, visible in /api/automation. Factory status (`factory-status.ts`) derives a `landBlocked` banner (`deriveLandBlockStatus`) from that channel's rollup row, and the webapp strip (`FactoryStatusStrip`) renders it as a red "Fleet cannot land: main checkout dirty — …" banner above the headline. No more silent accumulation in `land-failures.json` (whose retryable-never-bumps-streak behavior is unchanged and re-asserted by test).

**Proof:** `tests/land-blocked-recording.test.ts` drives the REAL `SquadManager.land()` over real git repos: dirty-main refusal ⇒ `{landed:0, rejected:0, blocked:1}` + streak 0 + warn `land` event + `landBlocked.blocked === true`; clean land ⇒ `{landed:1, rejected:0}` (no `blocked` key) + no banner; conflicting (non-retryable) failure ⇒ `{landed:0, rejected:1}` + streak 1 + no banner. The first test is the regression guard: re-coupling the statistic to `!retryable` fails it even if `model-outcomes.ts` is untouched. Plus `recordModelOutcomeBlocked` unit tests (incl. old-shape on-disk file) and `deriveLandBlockStatus`/`landBlockedLine` tests. `bun run check` clean; full `bun test` 1844 pass / 0 fail; webapp 578 pass.

**Deliberately left:** the concern's original Verify (a live-daemon land populating `~/.glance/model-outcomes.json`) still needs a real fleet land on the now-clean main under the restarted daemon — that is an operational step (restart daemon, drive a land), not a code gap; concern 02 (key verification) picks up from there.
