# Land blast-radius gate
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land.ts, src/land-risk.ts, src/land-risk.test.ts

## Goal
A large or risky-path diff does not AUTO-land into main unattended; it's blocked and left for a human Land click. Default-off, fail-open, bypassable.

## Approach
- New `src/land-risk.ts`: `landRiskReason(repo, branch, opts): Promise<string | undefined>` — computes the branch's OWN changed set `git diff --name-only <merge-base(HEAD,branch)>..<branch>` (NOT staleBranchReason's overlap axis, which is staleness). Returns a reason when: changed-file count ≥ `OMP_SQUAD_LAND_MAX_DIFF_FILES` (envInt, default e.g. 40), OR any changed path matches a risky-path regex (reuse the spirit of squad-manager `RISKY_RE`: secrets, deploy/prod/mainnet, lockfiles, CI config, .env). Never throws (probe failure → undefined, like staleBranchReason). Gated by `landRiskGateEnabled()` = `OMP_SQUAD_LAND_RISK_GATE === "1"` (default OFF).
- `src/land.ts` `landAgentImpl`: after the stale-gate line (~:395), compute `const riskReason = !opts.riskOverride && landRiskGateEnabled() ? await landRiskReason(repo, branch) : undefined;` and, where the stale gate is enforced on the --no-ff path, block with `{ ok:false, committed, merged:false, message, detail: riskReason }`. Add `riskOverride?: boolean` to `LandOpts` (mirror `validatorOverride`); the human Land / force path sets it so the button always works (ASK = human resolves).

## Verify
`bun test src/land-risk.test.ts`: >threshold file count → reason; risky path (e.g. `.github/workflows/x.yml`, `.env`) → reason; small safe diff → undefined; unreadable repo → undefined; gate off → undefined. Live-drive: a branch with a 50-file diff is blocked from auto-land, `riskOverride:true` lands it.

## Resolution (2026-07-07)
Shipped. `src/land-risk.ts` + wired into `landAgentImpl` (blocks every merge path, `riskOverride` bypass) + `tests/land-risk.test.ts` (7 pass, drives a real git repo). Default-off, fail-open. Full suite 1702 pass/0 fail; tsc clean. Also fixed: concept #1's `model-lineage.test.ts` was orphaned in `src/` (bunfig scopes `bun test` to `tests/`) → moved to `tests/`.
