# Lens judge machinery — one out-of-criteria lens on the existing judge path
STATUS: done — re-landed via PR #110 (c112a4f), lens code + tests on main; verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/validator.ts, src/types.ts, tests/validator.lens.test.ts

RE-LAND NOTE (2026-07-07): code cherry-picked back from orphaned worktree-research-recursive-orchestration (was merged in PR #96 as plan-only, code never reached main) — see reland/pr96-review-lens; STATUS held at in-review until that PR merges. Also fixed: its `*.test.ts` files lived under `src/`, outside bunfig.toml's `[test] root = "tests"` scope — the "48 lens tests" never actually ran in the gating `bun test`; moved to `tests/` so they do.

## Goal

A `LensJudge` seam and an `ompLensJudge(lens)` implementation that runs one focused,
out-of-criteria review of a diff on the **same** `decideTyped`/`omp -p` machinery the criteria
judge already uses — with a hard fail-open contract: any throw, timeout, or unparseable output
yields `undefined` (no signal), never a fabricated accept/object and never a rejection that can
escape to the land path.

## Approach

In `src/types.ts`, add (alongside the existing `ValidationRecord` `sameLineage` extension):
```
export type LensVerdict = { lens: LensId; disposition: "accept" | "object"; severity: "low" | "high"; claim: string };
```
and extend `ValidationRecord` with `lensAdvisory?: LensVerdict[];` (concern 05 adds `lensVerify?`).

In `src/validator.ts`, sibling to the `Judge` seam (`:29`):

- `export type LensJudge = (input: { lens: LensId; diff: string; proof?: string }) => Promise<LensVerdict | undefined>;`
- `ompLensJudge(lens: LensId): LensJudge` built on the **same** `decideTyped` call as `ompJudge`
  (`:157-165`) — same `omp -p`, same 12k/2k truncation (`judgeUserPrompt`, `:149-153`), same
  cross-vendor selection via `activeReviewer()` (`:44-56`) so an operator can put the lens on
  `codex` while the criteria judge stays `omp`.
- Per-lens `SYSTEM_PROMPT`. The v1 `regression` lens prompt: *"You are an independent reviewer.
  You are NOT checking whether any declared acceptance criteria are met — assume another reviewer
  did that. Your ONLY job: does this diff introduce a problem the acceptance criteria would not
  have named — a security regression, a scope violation, data loss, a broken failure path?
  Inspect the diff directly; distrust the author's description. Respond `accept` if you find none,
  `object` with a one-line `claim` and `severity` if you do."*
- **Guard the parser.** `decideTyped` does NOT wrap `opts.parse()` (`omp-call.ts:65`). Wrap the
  lens parser in try/catch → `undefined` on any throw, mirroring how `extractJsonObject` internally
  guards `parseRawVerdict`. The whole `ompLensJudge` body must be `try { ... } catch { return undefined; }`
  so it satisfies the same never-throws contract as `ompJudge`.
- Apply a per-lens timeout (`OMP_SQUAD_LENS_TIMEOUT_MS`, default 60s, shorter than the criteria
  judge's 120s) via the `AbortSignal.timeout` path `decideTyped` already honors; a timeout →
  `undefined`.

Do NOT wire this into `validatorGate` yet — that is concern 03. This concern delivers the seam +
implementation + tests only.

## Cross-Repo Side Effects

`ValidationRecord` gains optional fields — all optional, so no consumer breaks. `finalizeRun`
(concern 04) and the UI (deferred) read them later.

## Verify

`src/validator.lens.test.ts` with an injected fake `LensJudge` and a stubbed `decideTyped`:
- lens returns a well-formed `object` verdict → parsed through correctly.
- lens process throws → `ompLensJudge` resolves `undefined` (fail-open contract).
- lens emits garbage JSON → parser throw is caught → `undefined`.
- lens times out → `undefined`.
- `activeReviewer()` override routes the lens to the codex path when configured.
- `bun test src/validator.lens.test.ts` green; `tsc` clean.
