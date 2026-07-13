# Fault-injection property harness over every probe-backed gate
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: tests/helpers/git-fault.ts (new), tests/gate-fault-injection.test.ts (new), scripts/gate-fault-report.ts (new)

## Goal
Prove generatively that **no probe-backed gate returns "allow" under a fault.** One harness injects a
matrix of real faults into each gate and asserts the verdict is a refusal (or an explicit, named
inconclusive), never an allow, never `undefined`, never `[]`. This catches the semantic and ordering
fail-opens a type cannot see, and it regression-locks the 15 fail-closed fixes shipped in PR #158.

## Approach
- `tests/helpers/git-fault.ts`: a PATH-shim git that fails a *named* subcommand with a chosen exit code
  and stream content, delegating everything else to the real binary. Follow the shim pattern already
  used in `tests/land-stale-gate.test.ts` (a genuine live-fault reproduction, not a return-value stub).
  Fault matrix per gate: `exit 1 + empty stdout/stderr` (no common ancestor), `exit 128 + stderr`
  (unknown revision / deleted ref), spawn failure (binary missing), empty stdout on exit 0, timeout,
  disk-full on write, and a shallow repository (`clone --depth 1`).
- Gates under test (each gets a row per fault): `landRiskReason`, `transplantedCommitsReason`,
  `staleBranchReason`, `greenGateUnproven`, `gateRunUnrunnable`, `confirmedGate`, `suiteFailures`,
  `readFailures`, `proofGate`, `packageManifestError`, `aheadOfBase` (post-concern-02),
  `detectVerify`, `runMainGateUncached`.
- The assertion is a **property**, not a fixture: for every (gate, fault) pair the result must be in
  the refuse/inconclusive set. Where a gate legitimately allows under a specific fault — the two known
  cases are `transplantedCommitsReason` on a genuinely nonexistent branch, and `staleBranchReason` on
  unrelated histories — that pair is an **explicit, annotated exception** carrying the reason, so the
  exception list is the honest inventory of every sanctioned fail-open in the codebase.
- Ship `bun scripts/gate-fault-report.ts` printing the (gate × fault) matrix with pass/exception/FAIL,
  mirroring the effect-migration report's shape. This is the artifact concern 05 decides on.
- Deliberately advisory gates (lens panel, cost-gate shadow, policy tighten-only, lease-hook, dispatch
  `alreadyDone`, orphan `cherryCheck`) are OUT — they are documented fail-opens and must stay so.

## Cross-Repo Side Effects
None.

## Verify
The harness fails on `git revert`-ing any one of PR #158's fixes (spot-check three: the transplant
carve-out, `land-risk`'s no-common-ancestor block, `greenGateUnproven`'s ordering) and passes on
current main. Full suite green. `bun scripts/gate-fault-report.ts` prints a matrix with zero FAIL rows
and every exception annotated.
