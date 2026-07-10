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

## Adjudication: finding 5

Re-verified against current `src/validator.ts` (post-G3; G3 never touched this file — last real
change was membrane-disciplines/gate-log-offload, both unrelated to the abstain path). The finding
has two genuinely separate parts; they get different verdicts.

**Part A — judge unreachable/throws/unparseable ⇒ `abstain` (`scoreAgainstCriteria`, the
`!raw || raw.perCriterion.length === 0` branch): WORKING AS DESIGNED, no code change.**

This is explicitly the epic-3 DESIGN §3 contract (`Judge`'s own doc comment: "Never throws by
contract — a throw is treated the same as `undefined` — abstain, fail-open"), and it is a *different
kind* of checker than everything else in this wave. Every other finding in waves 1+2 guards a
checker that is the ONLY signal standing between a bad change and a merge (the acceptance gate, the
regression gate, the transplant/stale probes). The validator is additive on TOP of those — by the
time `validatorGate` runs, `landAgent`/`landAgentPr` still have to clear the acceptance gate,
regression gate, dirty-main guard, and (after this wave) the red-on-red set-diff, transplant probe,
and stale-branch probe, ALL fail-closed. An unreachable judge does not remove any of that; it only
means the ADDITIONAL criteria-adherence check didn't run. Fail-open here is a deliberate trust-
layering choice (semantic review is advisory-strength by construction — the lens panel one layer up
is explicitly advisory too, per DESIGN.md's "Membrane placement" and the validator's own veto being
"bypassable ONLY by an explicit `validator-override` at the caller"), not an oversight. Making an
`omp`/`codex` outage fail-CLOSE every land in the fleet would trade a contained, honest gap (one
extra check skipped, logged in the record's `rationale`) for a total autonomy stall — worse than the
gap it would close, and out of proportion to what the validator actually guards.

**Part B — empty diff ⇒ `abstain`, when the emptiness came from a `computeLandDiff` FAILURE rather
than a genuine no-op land: REAL, narrow residual gap. Deferred — no code change in this PR.**

`computeLandDiff` (validator.ts:458-484) wraps its git calls in a blanket `try { … } catch { return
""; }` and a `rev-parse HEAD` failure returns `""` immediately. `scoreAgainstCriteria` cannot tell
"this land genuinely changed nothing" (in-place, no-op — the documented, common case `!diff.trim()`
exists for) from "the diff computation itself errored on a REAL change" — both read as the same
`abstain` with the same reassuring rationale ("empty diff — nothing to validate"). A unit with
declared criteria and a real diff that hits a git hiccup at exactly this moment lands with its
criteria silently unchecked, mis-labeled as a legitimate no-op rather than a failed probe.

Why this is real but narrow, and why it does not get fixed in this PR:
- `validatorGate` runs in `SquadManager.landBranch` BEFORE dispatching to `landAgent`/`landAgentPr`
  (its own doc comment says so), so it executes before this wave's freshly-hardened dirty-main/status
  checks get a chance to catch the same underlying git unhealthiness — there IS a live window where
  this residual is the only thing standing between a real change and an unchecked land.
- But the fix belongs in `computeLandDiff`/`scoreAgainstCriteria` (distinguish "genuinely nothing to
  diff" from "the probe errored" — e.g. via `classify-probe-failure.ts`'s taxonomy, same shared
  classifier this wave used everywhere else), and `src/validator.ts` is **not** in concern 07's
  TOUCHES (`src/land.ts`, `src/land-pr.ts`, `src/done-proof.ts`, `src/intake.ts`,
  `src/squad-manager.ts`, `tests/`). Per this concern's own scope discipline (DESIGN.md's own "Fail-
  closed wave split... by behavioral blast radius" reasoning, and the explicit rule here: "forced
  out-of-TOUCHES edits go in notes"), it is recorded here rather than smuggled into land.ts.
- Follow-up: a small concern touching `src/validator.ts` to make `computeLandDiff` return a
  distinguishable "probe failed" signal (not just `""`), and have `scoreAgainstCriteria` route that
  through `classifyProbeFailure` to a `"probe-failed"` verdict distinct from `"abstain"` — visible in
  the record, not silently indistinguishable from a real no-op.

## Cross-Repo Side Effects
None.

## Verify
Reproduce-first tests per finding (old behavior fails under new code); full `bun test`; scratch-
daemon land of a branch with a deliberately new failing test on a red baseline is REFUSED with a
visible reason; a green land's full gate output file exists under gate-logs/.
