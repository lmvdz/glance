# Design: base-aware land gate (worse-than-baseline, applied to omp-squad)

Origin: `/research vyuh-labs/dxkit` → `/plan`. dxkit's transferable concept is a
**worse-than-baseline acceptance gate** (block only what *this change* introduced, so a
brownfield repo with pre-existing debt is still landable). This design applies that *pattern*
to omp-squad — and, after adversarial review, explicitly **rejects adopting dxkit itself**.

## Verdict
**Reject the dxkit-backed net-new gate. Ship the base-snapshot gate (zero new deps).**

Two independent opus red-teams (correctness, scope) converged on the same conclusion. The
abstracted pattern, applied correctly to omp-squad's *actual* architecture, is ~20 lines in
`verifyMerged`, not an 8-scanner dependency.

## Approach (chosen)
Today `verifyMerged` (src/land.ts:159-171) runs the repo's gate (`detectVerify`, intake.ts:97)
on merged main and `git reset --hard head0` on any non-zero exit. That refuses every land when
the repo is *already* red at base — the gate can't tell "repo was red" from "branch broke it".

Make the gate **base-aware** using `head0`, which the land already captures (src/land.ts:154)
and which is always reachable (it is the reset target / merge ancestor):

| base @ head0 | merged main | action | vs today |
|---|---|---|---|
| n/a (no gate) | — | land | unchanged |
| pass | pass | land (verified) | unchanged |
| pass | **fail** | reset → block (branch regressed) | unchanged |
| **fail** | pass | land (branch *fixed* the red baseline) | unchanged (already lands) |
| **fail** | **fail** | **land + log "landed onto a red baseline; main was not green at head0"** | **changed: today blocks (wedge)** |

The only behavior change is the last row: a red base no longer blocks every land. On a green
base, behavior is byte-for-byte today's.

**Hot path stays free.** Order: merge → run gate on merged. If it passes → land (no base run;
the common case pays nothing extra). Only if the merged gate *fails* do we run the gate once at
`head0` (after the reset we were going to do anyway) to decide reset-vs-land. Extra compute lands
only on the already-slow failure path.

## Key decisions
| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Engine | the repo's own gate (`detectVerify`), already run | adopt dxkit; build generic net-new; gitleaks-only | dxkit is a *new* heavy dep that no-ops on arbitrary repos (no `.dxkit/` baseline) and is redundant where present; pattern needs zero deps here |
| Baseline anchor | `head0` (immediately-preceding landed main HEAD) | committed `.dxkit` SHA; fleet-attach snapshot; branch merge-base | head0 is always reachable, advances per-land race-free under `repoLands` serialization; fixed anchors wedge the fleet (RedTeamCorrectness #1) |
| Granularity | binary pass/fail of the existing gate | per-framework failing-test diffing | finer "didn't make red worse" needs test-output parsing — the trap that tempts a dependency; defer until proven needed |
| Security scanning | out of scope (target repo's CI owns it) | dxkit / gitleaks fleet-wide | omp-squad doesn't own target toolchains; a net-new-only gate does zero scanning on non-opted-in repos |
| Conflict reviewer swap | **not done** in this plan | replace LLM reviewer with net-new | net-new is orthogonal to semantic-merge → tautological no-op or silently approves broken merges (RedTeamCorrectness #3) |

## Red-team concerns addressed
| Concern (reviewer) | Severity | Resolution |
|---|---|---|
| Fixed baseline wedges fleet after first inherited finding (Correctness #1) | critical | Anchor at `head0`, not a fixed snapshot. The binary base-snapshot has no cross-land finding identity to drift, so the wedge cannot occur. |
| Two gate sites scan different trees, disagree, warm agent gone (Correctness #2) | critical | One authoritative site only: `verifyMerged` on merged main. No second net-new site added; `runProof` unchanged. |
| Deterministic-reviewer swap deletes semantic-merge check (Correctness #3) | critical | Dropped from scope. LLM reviewer untouched. |
| Fail-open silently re-arms brownfield wedge / parse let-through (Correctness #4) | significant | N/A — no dxkit, no JSON parsing, no fail-open. The gate is the repo's own command; the only "degraded" state is a logged red-baseline land, which is the intended behavior, surfaced in the land detail. |
| Baseline anchor reachability after rebase / shallow clone (Correctness #5) | significant | `head0` is the reset target and a merge ancestor — always present locally. No external anchor SHA. |
| Concurrency races on baseline files / dxkit cache (Correctness #6) | significant | No baseline files; gate runs are already serialized by `repoLands` at the land step. |
| YAGNI: unquantified brownfield-red frequency (Scope #1) | critical | The fix is ~20 lines, zero deps, and strictly dominates today's behavior on every axis — cheaper to ship than to instrument-then-decide. It also *emits* the signal ("landed onto red baseline") for free. |
| dxkit is a new dep, rung-4 misapplied (Scope #3) | critical | dxkit dropped entirely. |
| No-ops on arbitrary repos / redundant where present (Scope #4) | critical | dxkit dropped. |
| 2-4x scan cost (Scope #5,6) | significant | Base gate runs only on the merged-fail path; green common case unchanged. |
| Schema/lifecycle coupling to external CLI (Scope #7) | significant | No external CLI. |

## Out of scope / deferred (named ceilings)
- **"Didn't make a red repo *worse*"** — binary exit can't see it; needs per-framework failing-test
  counting. Defer until a landed-onto-red regression is actually observed. (ponytail ceiling.)
- **Deterministic conflict reviewer** (RedTeamScope Slice A: "rebased diff touches only
  branch-owned files + gate passed") — a real zero-dep improvement, but orthogonal; build only if
  the gameable-LLM-grader pain is demonstrated.
- **Fleet-wide secrets gate** — if ever needed, gitleaks-only diff-scoped (one dep, not eight),
  not dxkit. Belongs to target-repo CI by default.
- **Same base-aware logic for the autoresolve gate** (src/land.ts ~254) — narrower (textual-conflict
  lands only); fold in within the concern if cheap, else follow-up.

## Open questions
None blocking. Proceed to DECOMPOSE.
