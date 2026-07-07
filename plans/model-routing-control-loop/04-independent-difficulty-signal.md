# Independent difficulty signal on the outcome row
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/task-outcomes.ts (row shape), src/receipts.ts (filesTouched), src/workflow/engine.ts (visits, read), src/squad-manager.ts (visits.fixup surfaced ~:2405-2413,:4657-4658)
BLOCKED_BY: 03-joined-outcome-row
VERIFY_BLOCKER: `grep -n "recordTaskOutcome" src/task-outcomes.ts` exists

## Goal
Break the circularity that makes the raw matrix ungradeable: `tier = tierOf(thinking)` and `mode = verifyMode` are **both router outputs**, so grading the router by its own labels is self-justifying. Record an independent, post-hoc difficulty signal the router did **not** choose, so confounding is at least *visible* and a real difficulty model can grow later.

## Approach
Add difficulty fields to the C03 row, all derived from evidence the router didn't pick:

1. **`filesTouched` count** — already computed at `finish()` in `src/receipts.ts` and on `RunReceipt.filesTouched[]`. Blast radius is a task property, not a routing choice.
2. **diff LOC** (added+removed) if cheaply available from the land path / receipt; otherwise omit and note.
3. **`fixupCount`** — the in-run churn from the workflow engine visit counter `shared.visits[current]` (`src/workflow/engine.ts:100`), already surfaced as `WorkflowRunState.visits.fixup` and consumed for the fixups-to-green metric (`squad-manager.ts:2405-2413`, `:4657-4658`). Read it at the land/finalize join and stamp it on the row.

Record the router's chosen `tier` as *what we picked* (already in `routing`), and these three as *how hard it turned out* — never conflate them. The matrix (C05) can then group by chosen tier but also cross-tab against observed difficulty to expose "cheap tier only ever saw easy tasks."

**`rework-rate` honesty:** there is **no** post-merge revert/re-touch signal anywhere in the codebase (`recordLandOutcome` clears on success; the regression gate rolls back in-transaction as a land *failure*; re-dispatch is prevented, not counted). So define `rework` as the in-run `fixupCount` churn and **label it "in-run rework, not post-merge regression"** in the row and the surface (C05). True post-merge rework is a deferred signal (needs a new post-land follow-up/revert detector).

## Cross-Repo Side Effects
None. Additive fields on the task-outcome row; readers ignore unknown fields.

## Verify
- Land a unit that needed ≥1 fixup cycle; confirm the row carries `fixupCount ≥ 1` and `filesTouched > 0`.
- Land a first-try-green unit; confirm `fixupCount == 0`.
- Confirm the surface/label for rework explicitly says in-run (no false claim of post-merge regression).

## Resolution
Closed — added `filesTouched?`/`fixupCount?` to `TaskOutcomeRow`, populated at the `land()` row-write. Correctness catch: `dto.receipt` is a `ReceiptRollup` with NO `filesTouched` field (the spec's draft was wrong) — read from `readReceipts(stateDir, dto.id)` last entry instead (the confidence scorer's own blast-radius source). `fixupCount` from `rec.options.workflowState?.visits?.fixup` (identical access to the fixups-to-green metric). `diffLoc` omitted (would need new git --numstat plumbing). Documented as in-run churn, not post-merge regression (no such signal exists). +3 tests; tsc clean; full suite 1564/1564.
