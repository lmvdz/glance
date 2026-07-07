# Fix land-outcome recording — the unlock

STATUS: open
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
