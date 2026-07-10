# Fail-closed wave 2 — the land-path findings + land-path offload (post-G3)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03, 04
TOUCHES: src/land.ts, src/land-pr.ts, src/done-proof.ts, src/intake.ts, src/squad-manager.ts, tests/

## Goal
The ten fail-open findings that CAN refuse a land fail closed — after G3 merges, re-adjudicated
against the post-merge land path — plus the land-path half of the lossless offload. One atomic PR.

## Approach
HARD GATE: do not start until fix/one-green-loop is merged; re-verify every finding against the
merged code first (line numbers WILL have drifted; some findings may be fixed by G3 itself).
Adjudicated sweep: plans/eap-borrows/failopen-sweep.md.
- #1 land.ts:511 acceptance red-on-red: apply the same failure-set diff as applyRegressionGate
  before the red-baseline allowance; refuse on new failures. (The marquee fix — the living cousin
  of the historical equal-reds bug.)
- #2 land.ts:420 dirty-main: nonzero git status → refuse (retryable, bounded), never proceed —
  especially given the downstream reset --hard.
- #3 land.ts:545 autoresolve wtClean: require code===0 && empty; else treat dirty, skip autoresolve.
- #4 land-pr.ts:506 transplant probe: probe failure → block with "could not prove lineage".
- #6 land.ts:578 stale-branch probe: probe failure blocks auto-land; force-land stays the hatch.
- #8 land.ts:225 extractGateFailures: prefer unrunnable classification; unparseable reds refuse
  COMPARISON only — do not wedge red-baseline repos whose gate is check-first/tsc-only (this is
  why #8 is Wave 2: a naive fix refuses every brownfield land).
- #9 land-pr.ts:646: run gateRunUnrunnable (and zero-test check) on exit-0 too before merge.
- #10 intake.ts detectVerify: split ENOENT (honest skip — non-node repos are legitimate) from
  parse failure (fail closed). Never block a repo for not having package.json.
- #11 done-proof.ts hasProof tri-state: green closes; red-baseline closes with an annotation;
  unverified ESCALATES (attention) instead of silently closing — reconciler keeps working,
  brownfield issues don't zombify.
- #13 squad-manager runMainGateUncached: no command → distinct "skipped" result, never claims
  green tests.
- #5 validator abstain: adjudicate and record a verdict in this file (working-as-designed for
  unreachable judge; the empty-diff→abstain-with-criteria path is the part needing a decision) —
  code change only if the verdict says so.
- Offload: apply concern 03's budgetedExcerpt + writeGateLog to land-pr.ts scratch-gate output
  (today: 600-char on failure, DISCARDED on success) and land.ts truncate sites (~485/496/508/521
  pre-G3 numbering) — full output always persisted, pointer on the land record/DoneProof detail.
- All refusals route through classifyProbeFailure (concern 04): structural → escalate visibly,
  bounded retries only. No unbounded-retryable — that pathology already jammed the factory once.

## Cross-Repo Side Effects
None.

## Verify
Reproduce-first tests per finding (old behavior fails under new code); full `bun test`; scratch-
daemon land of a branch with a deliberately new failing test on a red baseline is REFUSED with a
visible reason; a green land's full gate output file exists under gate-logs/.
