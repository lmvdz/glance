# Design: fail-open defense — fault injection first, types second

Origin: after the eap-borrows run shipped 15 fail-closed checker fixes, the question was asked —
what would have caught those defects up front, cheaply? The first answer was "a `GateVerdict`
discriminated union across ~40 gates." An adversarial panel (sonnet designer → 2 opus red teams →
arbiter) **substantially rejected that answer**, and the rejection is the design.

## What the panel established

Red team A (type-system + migration safety) and red team B (value + cost) attacked independently
and converged. Both counted, per defect, what the type would actually have prevented:

| Defect class | Example | Would the type have caught it? |
|---|---|---|
| Implicit `undefined`/`catch` → allow | `land-risk` returning `undefined`; `.catch(() => ({ok:true}))` | **Yes** — the mechanism dies when `undefined` isn't in the return type |
| Semantic misjudgement | `merge-base` exit-1 read as a spawn error; transplant's over-broad `UNKNOWN_REVISION_RE` | **No.** The author writes `{kind:"allow"}` with equal conviction |
| Ordering / control flow | `greenGateUnproven`'s degraded check placed after the tests-ran short-circuit | **No.** No type orders your statements |
| Fail-CLOSED over-correction | permanent park; `reproducible` gate disabling the router | **No — and the proposed constructor made this class WORSE** |

Red team A's honest count: the type prevents ~7 of ~29 findings (~25%), all in the
fail-open-by-coercion class. Red team B's count: 1 clearly prevented, 3 already covered by the
ratchets in PR #160, and **5 catchable only by fault injection**. They agree on the shape of the
answer even where the numbers differ: **the type addresses the accident, not the wrong decision.**

## The two findings that killed the original design

1. **`GateVerdict.fromProbeFailure(classifyProbeFailure(input))` would re-create the interlock.**
   The design's headline was that 5 callers "discard" the classification's `escalate` bit and a
   constructor should force it through. They do not discard it by accident. `classifyProbeFailure`
   returns `retryable:false, escalate:true` absent a `maxAttempts` budget — correct for observer and
   convergence, which have no retry loop. The **land-loop** sites take only `.reason` and set
   `retryable: true` themselves, because their budget is the ~30s retry tick plus
   `landBlockedEscalateCap`. `land-pr.ts:543-548` names the alternative outright: hardcoding
   `retryable:false` on a probe failure "turned a transient hiccup into a PERMANENT park … exactly the
   interlock pathology this repo is named after." A blind constructor would flip all 15 sites and let
   `autoLandFailCap` (which by design *excludes* retryable refusals) park a branch after 3 transient
   dirty-main windows. **The safety feature would have restored the 1,381-death bug.**

2. **The scope boundary tracked the easy diff, not the risk.** The design excluded `aheadOfBase`'s
   `-1` sentinel as "a magnitude, not a verdict." Red team B read it: `aheadOfBase` returns `-1` on git
   failure; `agentHasUnlandedWork` and `persistedHasWork` ask `> 0`; `-1 > 0` is `false`; and
   `orchestrator.ts:220` does `if (!agentHasWork(id)) continue`. **A transient git fault silently skips
   the land, forever, with no escalation.** That is a live fail-open on main today, of exactly the class
   the refactor was proposed to fix, and it sat outside the refactor's scope. Fixed separately, first.

Corollary, recorded because it recurred three times this session: **the orchestrator's own framing was
the defect source.** The fix-list that caused the `land-risk` fail-open, the suppression list that hid
`extractGateFailures` from review, and PR #160's first ratchet description telling authors to route
land-loop refusals through `classifyProbeFailure` — all three were mine. Only reviewers who had *not*
read my framing caught them. See `.claude/skills/blind-review/`.

## Approach

Ship the cheap thing that catches the expensive class, then a narrow type where it genuinely pays.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Primary intervention | **Fault-injection property harness** over every probe-backed gate | 8-batch type refactor | Catches the semantic + ordering fail-opens (~5) the type provably cannot, and regression-locks the 15 fixes just shipped |
| The type | **Narrow union over the ~6 land-path gates that already return `X \| undefined`** — one batch | 40 gates / 20 files / 42 test files / 8 batches | Kills the `undefined`-means-allow mechanism exactly where code lands; the 8-batch version costs 8× to prevent ~1 net-new defect on the surface that just stabilized |
| `fromProbeFailure` | **Cut entirely** | forcing constructor | It inverts land-loop retry polarity and restores the interlock (red team A, finding 1) |
| Retry polarity | **Caller-supplied, never derived from the classification** | constructor-enforced | The budget is caller-local; `classify-probe-failure.ts:29-32` already says so |
| `acceptInconclusiveAsAllow` | **Cut** | audited downgrade + call-count ratchet | "Inconclusive ≠ allow, except through this function" is the bug with paperwork. A count ratchet bounds the *number* of fail-opens, not their correctness |
| `Allow{basis:"vacuous"}` | **Cut** | map `runMainGate`'s `skipped:true` to a vacuous pass | A laundering channel: "we didn't check" minted as an Allow. Sweep finding #13 says report skipped *distinctly* |
| `landableDirty`, `alreadyDone`/`issueAlreadyDone` | **Out of scope** | convert as "inverted booleans" | Not verdicts. `landableDirty` is a serialized `ProofFingerprint` field; `alreadyDone` is a documented advisory dispatch-skip (the original design contradicted itself, listing it both as advisory and as a conversion target) |
| `gateRunUnrunnable` | **Split its three-way `undefined` BEFORE any fold** | "already the right shape" | Its `undefined` means green-allow, real-red-handled-elsewhere, AND no-diagnosis. A naive fold turns a real red into an allow — a *new* fail-open created by the migration |
| `aheadOfBase` `-1` | **Fixed first, separately** | out of scope | Live fail-open; the orchestrator skips lands on a git fault |
| Enforcement | `gate-typed-undefined-return` ratchet, baseline **0 forever**; type-level compile test | exhaustive fold as the guarantee | Red team A: a `switch` + `assertNever` is equally exhaustive; excess-property checks are fresh-literal-only. The ratchet is the honest guarantee |

## Risks

- The narrow union still touches `land.ts`/`land-pr.ts`/`land-risk.ts` — the files that absorbed 15
  fixes. Mitigation: the fault-injection harness (concern 01) lands **first** and regression-locks
  those fixes before any signature changes.
- A partially-landed migration is worse than uniform fail-open (false confidence on the land path).
  Mitigation: one batch, six functions, atomic per function, no hybrid signatures.
- This repo leaks multi-batch refactors (PRs #27/#34/#35 merged into parent branches and never reached
  main; six orphaned re-lands). One batch is a deliberate response to that history.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| A1 `fromProbeFailure` re-creates the interlock | critical | Constructor cut; polarity stays caller-supplied |
| A2 `retryable:true` ratchet forces the same regression | critical | PR #160's description corrected (`4dd0b32`); the 14 are a ceiling, not debt |
| A3 design contradicts itself on `alreadyDone` | significant | Removed from scope (advisory) |
| A4 `landableDirty` is a wire field, not a gate | significant | Removed from scope |
| A5 `confidenceBelowFloor` has an un-unifiable twin in `autonomy.ts` | significant | Both left as booleans; documented, not half-migrated |
| A6 `gateRunUnrunnable`'s three-way `undefined` | significant | Concern 03 splits it before anything folds |
| A7 type-system prose overclaimed (excess-property freshness; fold ≈ switch) | minor | Claims downgraded; the ratchet is the guarantee |
| B1 the type prevents ~1-3 of 29 findings | critical | Scope cut to one batch; fault injection promoted to primary |
| B2 opportunity cost / leak probability | significant | 8 batches → 1; the follow-ups and G4 keep their cycles |
| B4 the advisory carve-out re-legalizes the bug | significant | `acceptInconclusiveAsAllow` and `basis:"vacuous"` both cut |
| B5 scope drawn where the work is easy | critical | `aheadOfBase` fixed first (concern 02) |

## Open Questions

None blocking. Concern 05 (whether to extend the union past the land path) is deliberately deferred
until concern 01's harness reports how many gates actually fail under fault injection.
