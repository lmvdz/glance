# Lens selector — decide whether a lens fires from the diff surface
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/lens-select.ts, src/lens-select.test.ts

## Goal

A pure, no-LLM function that decides, from the diff text alone, which out-of-criteria lens(es)
should run — or none. This is the affordability gate: a docs/config-only land pays zero extra
cost because selection short-circuits to `[]` before any lens spawn.

## Approach

Create `src/lens-select.ts`:

- `export type LensId = "regression"` for v1 (the single out-of-criteria lens). Type it as a
  string union so the deferred pool (`"perf" | "architecture" | "testing"`) extends it without a
  breaking change.
- `export function selectLenses(diff: string, criteriaText?: string): LensId[]`.
  - Parse changed file paths **straight from the diff text** (`diff --git a/x b/x` headers) — do
    not shell out to git; `validatorGate` already has the diff in hand.
  - Reuse the existing risk substrate rather than inventing new heuristics:
    - `RISKY_PATH_RE` (`src/land-risk.ts:29`) — auth/secrets/infra/lockfile paths → fire the
      `regression` lens.
    - the blast-radius file-count signal (`maxDiffFiles`, `src/land-risk.ts:21`) at a **lower,
      advisory bar** → fire on broad diffs.
    - `HIGH_RISK` (`src/intake.ts:34`) matched against `criteriaText`/task text → fire.
  - Define `DOCS_ONLY_RE` (`.md`, lockfiles-only, pure config). If **every** touched path matches
    it, return `[]`. **Mixed diffs are treated as risky, not docs** (conservative bias — a "docs"
    change that is really an executed prompt file must not silently skip the lens).
  - Respect `OMP_SQUAD_LENS_MAX` (default 1) and an optional `OMP_SQUAD_LENS_SET` CSV override
    (debug) — but keep env reads in the caller (concern 06) and pass the resolved cap/allowlist in
    as args, so this module stays pure and unit-testable without env.

Signature to keep the module pure: `selectLenses(diff, { criteriaText?, max, allow? })`.

## Cross-Repo Side Effects

None. New standalone module; nothing imports it until concern 03.

## Verify

`src/lens-select.test.ts` against synthetic diffs:
- docs-only diff (`README.md` + `bun.lock` only) → `[]`.
- `.env` / `.github/workflows/*` / `src/auth/*` diff → `["regression"]`.
- mixed docs + one source file → `["regression"]` (not `[]`).
- `max: 0` → `[]` regardless of surface.
- broad diff (> blast-radius bar) → fires even without a risky path.
- `bun test src/lens-select.test.ts` green.
