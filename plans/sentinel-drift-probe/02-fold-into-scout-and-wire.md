# Fold the drift lens into Scout's scan + wire the action-free sink
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/scout.ts, src/squad-manager.ts, test/scout.test.ts

## Goal
Invoke the drift lens (concern 01) on the reasoning slice Scout already reads mid-run — one cursor, one cadence, no second consumer — and wire the manager-owned action-free sink that runs `confirmDrift` and appends to the audit log. Default OFF. This is the only concern that edits existing files.

## Approach

### `src/scout.ts` — fold in the read, stay a relay
Scout keeps ownership of the single per-agent cursor; the drift lens rides its existing `runScan` reasoning slice so there is **no second `takeScoutReasoning` consumer** (this is what dissolves the cursor-steal race — do not add a second cursor or timer).

- Extend `ScoutDeps` with two OPTIONAL fields (absent ⇒ Scout behaves exactly as today):
  - `driftExtract?: Classify` — the cheap one-shot for drift classification (separate from `extract`).
  - `onHypothesis?: (h: Hypothesis) => void` — the ONLY drift output edge. Scout merely relays; it does not judge, confirm, steer, or import `validator`/`rpc-agent`. Keeping the sink an injected callback preserves the monitor/judge separation (Scout is still just a filer).
- In `runScan`, after the existing backlog extraction, when `sentinelEnabled()` && `driftExtract` && `onHypothesis` && the scan context carries `criteria` (see below): gate the drift call on a **separate** `ScoutCallBudget` (the sentinel budget from concern 01, constructed in Scout's ctor when `driftExtract` is present), run `buildDriftPrompt`→`driftExtract`→`parseDriftHypothesis`, and if non-null call `onHypothesis(h)`. Wrap in the same contained-try discipline as the backlog path (never throw, record via `deps.record`). The drift classification is fire-and-relay — Scout does not await the judge.
- Extend `ScanContext`/`ScanInput` with optional `criteria?: FeatureCriterion[]` and `runId?: string` (runId already flows in from the manager's `liveReasoning` map at squad-manager.ts:864; criteria is new). `monitorEligible` is enforced upstream (manager) by simply not supplying `criteria` for ineligible units — a criteria-less ScanInput skips the drift path (and the judge would "skip" anyway).

### `src/squad-manager.ts` — supply criteria + wire the sink
- At the Scout wiring (~line 857, where `new Scout({...})` is constructed with `liveReasoning`): also pass `driftExtract` (a `--smol --no-tools` one-shot like the backlog `extract`), and an `onHypothesis` sink.
- In the `liveReasoning` map (~line 861-864), add `criteria` for **eligible** units only: `monitorEligible(rec)` = the unit has declared `acceptanceCriteria` (from `rec.dto.acceptanceCriteria` / the `opts.criteria ?? pf?.acceptanceCriteria` resolution used at landBranch ~line 2597) AND not env-denied. Ineligible ⇒ omit `criteria` (drift path no-ops). This is the code-grounded eligibility gate — criteria-less/ad-hoc units are skipped.
- The `onHypothesis` sink (manager-side, where acting IS allowed but we deliberately do NOT act): build `ConfirmDeps` from the live record — `criteria` (same resolution), `diff: () => gitDiffAgainstHead(rec.worktree)` (reuse the hardened `--no-ext-diff` working-tree diff helper; if it is currently private to `convergence-run.ts`, export it or add a small shared `git-diff.ts` helper — do NOT reimplement the harden flags), `stillLive: () => rec.run?.snapshot().runId === h.runId` (the runId turnover guard, red-team A3), `stateDir`. Call `confirmDrift(deps)`. **Do not** surface, steer, or feed `confidence.ts` — v0 only appends to the audit log.
- Everything behind `sentinelEnabled()` (default OFF), so a daemon with the flag unset is byte-for-byte unchanged in behavior.

## Cross-Repo Side Effects
None outside omp-squad. If the working-tree-diff helper is extracted from `convergence-run.ts` into a shared module, update `convergence-run.ts` to import it (behavior-preserving) — verify its existing tests stay green.

## Verify
- `bun test test/scout.test.ts` green — including a NEW test proving that with `OMP_SQUAD_SENTINEL` unset, `driftExtract` is never called (Scout unchanged when disabled), and with it set + a drifting-reasoning fake `driftExtract` + a criteria-bearing ScanInput, `onHypothesis` fires exactly once and the backlog path is unaffected.
- Manual/daemon check: run the daemon with `OMP_SQUAD_SENTINEL=1` on a unit that has acceptance criteria, drive it to visibly pursue an off-criteria tangent, and confirm a line appears in `<stateDir>/sentinel-audit.jsonl` with a `judgeVerdict`; confirm a criteria-less unit produces no line; confirm the flag unset produces no line and no extra LLM calls.
- Contract re-check: `grep -nE "from \"\./(validator|rpc-agent)" src/scout.ts` returns nothing (Scout still cannot judge or steer — it only relays via `onHypothesis`).
- `git grep -n confidence src/drift-lens.ts src/drift-audit.ts` returns nothing — drift never touches the confidence score.
