I'll sweep `src/**/*.ts` for fail-open checkers: gate/probe error paths that swallow failure and read as green. Starting with the priority files and the common patterns that produce that class.Reading the priority gate/proof files and scanning for the classic fail-open patterns.That `observer.ts` catch returning `{ ok: true }` looks load-bearing — reading it and the other land-path gate sites next.Checking a few remaining high-impact edge cases, then compiling the ranked report.## Verdict

The historical regression-gate class has been **partially fixed** (`gateRunUnrunnable` + set-based `decideRegressionGate` on the **full-suite** path). Several **other** land/merge/audit checkers still treat checker failure, unreadable input, or inconclusive results as green / non-blocking. Ranked by how load-bearing they are on commit/land/merge.

---

## CRITICAL / HIGH — land/merge path

### 1. FAIL-OPEN — Acceptance gate red-on-red lands without failure-set comparison
**`src/land.ts:511–522`** (`verifyMerged`)

| | |
|---|---|
| **Checker** | Post-merge acceptance gate (opts.verify / detectVerify) |
| **Error path that reads green** | Merged run fails AND base run fails AND both are “runnable” → re-merge and `ok: true` with “landed onto a red baseline”. **No** `decideRegressionGate` / `extractGateFailures` comparison. Explicit ponytail: *binary gate can't tell "still red" from "redder"*. |
| **Scenario** | Main is already red (brownfield). Branch adds new failing tests. Acceptance fails both sides → land **succeeds**. Full-suite regression gate may catch this **only if** enabled and `detectVerify` finds a suite; if disabled (`OMP_SQUAD_REGRESSION_GATE=0`) or suite detection fails, code merges. |
| **Fix** | Apply the same set-diff as `applyRegressionGate` (or call it with the acceptance command) before red-baseline allow; refuse when new failures appear. |

This is the closest living cousin of the “equal reds read as green” historical bug, on the **acceptance** path rather than the regression path.

---

### 2. FAIL-OPEN — Dirty-main guard ignores `git status` failure
**`src/land.ts:420–422`**

| | |
|---|---|
| **Checker** | “Main has uncommitted tracked changes” interlock |
| **Error path** | Blocks only when `mainStatus.code === 0 && stdout.length > 0`. Nonzero status (broken gitdir, sandbox, permissions) → **no block** → merge proceeds. |
| **Scenario** | Corrupted/unreadable main checkout; status fails; land merges then `reset --hard` on gate failure **destroys** work the guard was meant to protect—or proceeds without knowing dirtiness. |
| **Fix** | Nonzero/unreadable status ⇒ refuse land (`retryable: true`), same as dirty. |

---

### 3. FAIL-OPEN — Autoresolve “worktree clean” ignores status exit code
**`src/land.ts:545–546`**

| | |
|---|---|
| **Checker** | WIP-clean prerequisite before rebase auto-resolve |
| **Error path** | `wtClean = status.stdout.length === 0` — never checks `code`. Failed status often yields empty stdout ⇒ **treated as clean** ⇒ rebase may clobber live agent WIP. |
| **Scenario** | `git status` fails in worktree; autoresolve runs; uncommitted work lost. |
| **Fix** | Require `code === 0 && stdout empty`; otherwise treat as dirty / skip autoresolve. |

---

### 4. FAIL-OPEN — Transplant gate on git error
**`src/land-pr.ts:506–514`** (`transplantedCommitsReason`)

| | |
|---|---|
| **Checker** | “Would this PR publish non-fleet local commits?” (pre-push lineage gate) |
| **Error path** | `publishing.code !== 0` or empty → `undefined` (allow). Same for `foreign` rev-list. |
| **Scenario** | Transient git failure / bad ref during probe → transplant guard silent → operator private commits can be pushed/merged. |
| **Fix** | Probe failure ⇒ block land (`ok: false`, non-retryable or retryable-with-detail “could not prove lineage”), never allow. |

---

### 5. FAIL-OPEN (documented design) — Independent validator `abstain` does not block land
**`src/validator.ts:300–333`, `575–612`**; **`src/squad-manager.ts:3174–3176`**

| | |
|---|---|
| **Checker** | Epic 3 criteria judge (`validatorGate` / `scoreAgainstCriteria`) |
| **Error path** | Judge throw/timeout/unparseable, empty criteria path handled, **empty diff** → `verdict: "abstain"`. Gate returns no `veto` unless `verdict === "veto"`. Land continues. |
| **Scenario** | `omp`/`codex` down or JSON garbage; unit with declared criteria lands **without** semantic check. Empty/unreadable diff (`computeLandDiff` → `""` on any error, lines 412–437) forces abstain even with criteria. |
| **Fix** | Config/mode: treat `abstain` as block when criteria exist (fail-closed), or require proof + criteria pass for auto-land; never map “couldn’t judge” to allow for declared criteria. |

Labeled intentional in DESIGN §3 / types.ts. **Label is honest for “unreachable judge”**, but empty-diff → abstain on a **real** change (in-place / base collapse failure) is a silent miss — borderline abuse of “abstain”.

---

### 6. FAIL-OPEN — Stale-branch gate on probe failure
**`src/land.ts:578–585`** (`staleBranchReason`); used local + PR (`land-pr.ts:632–636`)

| | |
|---|---|
| **Checker** | Stale fork + overlapping files (silent clobber) |
| **Error path** | merge-base / rev-parse / diff failures → `undefined` → **no block**. Doc: *must never block on its own bugs*. |
| **Scenario** | Git probe fails while branch is actually stale → clean merge can clobber newer main. |
| **Fix** | Probe failure ⇒ block (or at least block auto-land); force-land remains escape hatch. |

---

### 7. FAIL-OPEN — Land-risk gate on probe failure (default OFF)
**`src/land-risk.ts:8–9, 43–65`**; wired **`src/land.ts:436–442`**

| | |
|---|---|
| **Checker** | Blast-radius / sensitive-path auto-land gate |
| **Error path** | Any throw or nonzero git → `undefined` → no block. Default `OMP_SQUAD_LAND_RISK_GATE=false`. |
| **Scenario** | Gate on but merge-base fails → large/sensitive diff auto-lands. |
| **Fix** | When enabled, probe failure ⇒ block auto-land (`riskOverride` still for human). |

---

### 8. AMBIGUOUS / residual — Failure extraction collapses distinct reds
**`src/land.ts:225–233`** (`extractGateFailures`) → **`decideRegressionGate`**

| | |
|---|---|
| **Checker** | Regression / ratchet failure identity |
| **Error path** | No `(fail)` lines → single token = first non-empty line or `"gate"`. Two different env/tool failures with the **same** first line → set-equal → allow. |
| **Scenario** | Non-bun suites / tsc-only reds / sandboxed “command not found” with identical wrappers; if `gateRunUnrunnable` misses the shape, regression allows. |
| **Fix** | Prefer unrunnable/closed; for unparseable reds, refuse comparison (`allow: false`) rather than synthetic singleton identity. |

`gateRunUnrunnable` covers the worst env cases on the **local** regression path; this remains the residual equal-red hole.

---

### 9. AMBIGUOUS — PR acceptance path has no unrunnable classifier
**`src/land-pr.ts:646–649`**

| | |
|---|---|
| **Checker** | Scratch-merge acceptance before `gh pr merge` |
| **Error path** | Nonzero → blocks (fail-closed). Exit **0** with “suite never ran” / empty success is not classified. PR `runGate` also drops `degraded` (regression re-plans via land.ts, so degraded still applies to regression only). |
| **Scenario** | Broken verify script exits 0; or zero-test green. Land proceeds, DoneProof `verified: "green"`. |
| **Fix** | Run `gateRunUnrunnable` (and zero-test / empty-run checks) on green and red; refuse merge if suite did not exercise code. |

---

### 10. AMBIGUOUS — No acceptance command ⇒ land with only optional regression
**`src/land.ts:447–459`**, **`src/land-pr.ts:646–650`**, **`src/intake.ts:156–158`**

| | |
|---|---|
| **Checker** | detectVerify / acceptance |
| **Error path** | Unreadable/missing package.json or no scripts → `detectVerify` undefined → skip acceptance; regression also null if no suite. Recorded as green land / “no acceptance gate”. |
| **Scenario** | Malformed package.json → silent “no verify” → merge without tests. |
| **Fix** | Distinguish “intentionally no suite” vs “could not detect”; for repos that previously had verify, fail closed. |

---

## HIGH / MEDIUM — DoneProof, close, observer (downstream of land)

### 11. FAIL-OPEN — `hasProof` ignores `verified` grade
**`src/done-proof.ts:91–93`**; **`closeLandedIssue` `squad-manager.ts:5526–5537`**

| | |
|---|---|
| **Checker** | DoneProof authorizes Plane close / “landed” |
| **Error path** | Any ledger entry (including `verified: "red-baseline"` or `"unverified"` from out-of-band merge, lines 5745–5746) ⇒ close proceeds. |
| **Scenario** | Out-of-band GitHub merge records `unverified` DoneProof → autoclose treats as proven Done. |
| **Fix** | `hasProof` / close require `verified === "green"` (or explicit operator override for red-baseline). |

---

### 12. FAIL-OPEN — Observer regression audit: thrown gate → green
**`src/observer.ts:561–569`** (`confirmedGate`)

| | |
|---|---|
| **Checker** | Main acceptance for `auditTestsGreen` |
| **Error path** | `runGate().catch(() => ({ ok: true }))` — **any throw reads as green**. Flake path: red then green on retry also returns `ok: true`. |
| **Scenario** | `runMainGate` throws unexpectedly (or dependency throws before its own catch) → no regression finding; main stays red unnoticed. |
| **Fix** | Catch → `{ ok: false, firstFailure: "gate threw: …" }`. Keep flake re-run only for real red-then-green. |

Note: `runMainGateUncached` itself maps throw → `ok: false` (`squad-manager.ts:3561–3562`). The outer `.catch(() => ok: true)` is still a hard fail-open if anything above that throws.

---

### 13. FAIL-OPEN — Observer main gate: no verify command ⇒ green
**`src/squad-manager.ts:3551–3552`**

| | |
|---|---|
| **Checker** | `runMainGateUncached` |
| **Error path** | `!command` → `{ ok: true }` (documented). |
| **Scenario** | detectVerify fails open → Observer never files regressions. |
| **Fix** | Report `skipped`/unknown distinctly from green; don’t claim “tests green”. |

---

### 14. AMBIGUOUS — `isFresh(proof, headString)` skips live TTL/tree/dirty
**`src/proof.ts:130–137`**; call site **`squad-manager.ts:5881`**

| | |
|---|---|
| **Checker** | Proof freshness (confidence / workflow helper) |
| **Error path** | String-only path: after commit match + proof has fields → `if (!fp) return true` **without** TTL/dirty/live tree. Land path uses full fingerprint (safe). |
| **Scenario** | Expired proof still “fresh” for confidence → auto-land assist floor may be too optimistic. |
| **Fix** | String overload should still enforce TTL; or ban string form at production call sites. |

---

## MEDIUM — Convergence / ratchet

### 15. FAIL-OPEN — `suiteFailures` treats runner death as empty set
**`src/convergence-run.ts:309–320`**

| | |
|---|---|
| **Checker** | Ratchet input (suite failure set) |
| **Error path** | Explicit best-effort: spawn error → `[]`. No exit-code check; green and red both go through `extractGateFailures` on stdout/stderr only. |
| **Scenario** | Suite can’t run → `[]` → ratchet sees “no failures” / no new regressions → loop continues as if monotonicity holds. |
| **Fix** | Spawn/nonzero unrunnable → escalate or synthetic failure id `"suite-unrunnable"`, never `[]`. |

---

### 16. FAIL-OPEN — Corrupt failures sidecar re-baselines ratchet
**`src/convergence-oracle.ts:126–133`** (`readFailures`); **`src/convergence.ts:61–64`**

| | |
|---|---|
| **Checker** | Turn-over-turn ratchet |
| **Error path** | Read/parse error → `null` → treated as **baseline** (`allow: true`, no compare). |
| **Scenario** | Corrupt `failures.json` → next turn cannot see prior reds → new failures allowed. |
| **Fix** | Corrupt sidecar ⇒ escalate / fail closed, not baseline. |

---

## Intentional / advisory (label check)

| Location | Behavior | Label honest? |
|---|---|---|
| **`validator.ts` lens panel / VERIFY** | Failures → no signal; never veto | Yes — advisory; outer catch 604–606 |
| **`cost-gate.ts`** | Shadow only; catch swallow; `enforce` still shadow | Yes — v1 shadow |
| **`policy.ts`** | Missing/bad policy → empty rules → allow | Yes — tighten-only table; **not** a land proof |
| **`agent-guard` + policy** | Hardcoded denials stay; policy fail-open only for **extra** rules | Mostly yes |
| **`lease-hook.ts:142–144`** | Lease registry error → allow edit | Yes — advisory leases; **not** the hard guard (runs first) |
| **`harness-scorecard.ts`** | Advisory score only | Yes |
| **`dispatch.ts:325–326`** | `alreadyDone` throw → dispatch | Documented fail-open; wedge-avoidance — **not** a land gate |
| **`land-pr.ts:428–440`** | Orphan `cherryCheck` fail → log error, never unmerge | Yes — post-merge, non-blocking by design |
| **`gate-runner.ts` host/degraded sandbox** | Auto host fallback; degraded stamped | Honest when STRICT off; land uses unrunnable for **failed** degraded runs |
| **`workflow/codefix.ts:98`** | Always exit 0 | Yes — pre-pass, not goalGate |
| **`autoland.ts`** | Only lands on `outcome === "succeeded"` | Thin policy; real gates in land |

---

## Already fail-closed (not reported as findings; context)

- **`applyRegressionGate` + `gateRunUnrunnable`** on local regression path (post gate-image incident).
- **`proofGate` / `isFresh` with full fingerprint** on normal land.
- **`runProof`**: spawn/missing worktree → `ok: false`.
- **`landableDirty`**: status catch → treat dirty.
- **`assertMerged`**: gh/git failure → not merged.
- **`isAncestor`**: nonzero → false (blocks merge claim).
- **STRICT sandbox**: throw → land `runGate` returns code 1.

---

## Priority order to fix (if fixing the class)

1. **Acceptance red-on-red set-diff** (`land.ts:511–522`) — same class as the historical bug, still live on the land path.  
2. **Dirty-main + autoresolve status fail-open** (`420–422`, `545`).  
3. **Transplant probe fail-open** (`land-pr.ts:506+`).  
4. **Observer `catch → ok: true`** (`observer.ts:562`).  
5. **Validator abstain policy** when criteria exist (design change, not just a bugfix).  
6. **Stale/risk probe fail-open** when those gates are on.  
7. **Ratchet `suiteFailures` / corrupt sidecar**.  
8. **DoneProof close without `verified === "green"`**.

---

## Scope note

Swept priority files plus land/PR/manager/observer/convergence/validator/policy/guard/cost/risk/orphan/drift/intake/workflow verify. **Skipped** `tests/`, `webapp/`, `src/web/` as requested. Findings are **hypotheses for adjudication**; intentional advisory paths are separated so they don’t get “fixed” into hard blocks without product intent.

result: fail-open audit complete — top land-path risks are acceptance red-on-red, dirty-main/status ignore, transplant probe allow-on-error, and validator/observer inconclusive-as-green.
