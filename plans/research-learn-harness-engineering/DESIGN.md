# Design: harness-engineering gaps from learn-harness-engineering

Chained from `BRIEF.md` (research of walkinglabs/learn-harness-engineering). The research proposed
4 gaps; adversarial design (1 designer + 2 opus red teams) **cut 2.5 of them before any code** and
found a unifying root the research missed. This is the arbitrated result.

## The unifying root (the real finding)

`IssueRef` (`src/types.ts:168`) carries **no body/description field**. `dispatchSpawn`
(`src/squad-manager.ts:1064`) sets `task = "${identifier}: ${name}"` — the title only. The rich Tier-2
spec that the `promote-issue` skill authors into the Plane issue body (file paths, acceptance test,
verification gate, scope boundary) is **discarded at dispatch**. A fleet unit starts with: its title,
path-scope hints (`requires`/`owns`/`produces`), and a *fabric-similarity* context primer
(`buildContextPrimer`, which returns `""` on zero hits) — **never its own authored spec**.

This is the true root of the curriculum's gap-1 claim ("when the author knows it'll be E2E-validated
it authors upstream" — but the author never receives the contract) *and* of gap-3C. It wastes the
entire `promote-issue`/Tier-2 investment. Fixing it is the highest-value, self-contained win.

## Approach

Ship the coherent slice — **give the agent its spec, and make the gate that judges it fail fast and
legibly** — and drop the parts the red teams proved broken or premature.

## What ships

| Concern | What | Complexity | Value |
|---|---|---|---|
| 01 | Materialize the authored concern/Tier-2 body into the dispatched unit's context, sanitized + fenced as untrusted data | architectural | highest — fixes a confirmed capability leak |
| 02 | Split the land-gate into ordered fail-fast stages with per-stage receipts (observability-only) | mechanical | small, real legibility/speed win |
| 03 | Pre-dispatch harness scorecard, advisory shadow-only (DEFERRED — write, don't build) | architectural | marginal once 01 lands |

## What was cut, and why (verified, not speculative)

| Cut | Verdict | Evidence |
|---|---|---|
| **Gap 1B** — promote `runVisionPass` to a gating E2E stage | **DROP (category error)** | Vision opens a shared per-daemon `OMP_SQUAD_APP_URL` (`proof.ts:278`; both `runProof` call sites pass no `visionUrl`), never the worktree under land. No ephemeral per-worktree app boot exists anywhere. Under concurrency a "green" E2E proof is *anti-correlated* with the branch. Keep vision evidence-only (its module doc already says "NEVER gates a land"). |
| **Gap 2** — ledger consolidation / redirect readers to `buildFeatures` | **DROP (already built + cosmetic)** | `buildFeatures` (`features.ts:844`) is already the derived read-model backing the primary reader (`squad-manager.ts:2055`). Doc-side STATUS is **88 terminal / 23 open**, not 389 (that's a Plane-side un-closed count). The drift is reporting hygiene, not correctness; redirecting readers moves drift, doesn't reduce it, and puts `buildFeatures`' per-worktree git diffs on hot read paths. |
| **Gap 4** — golden-rule cleanup fleet | **DROP (DOA)** | Contradicts the hands-off product: cleanup units route through the same dispatch→land path and compete for the scarce land attention a supervisor-by-exception never gives; unlanded cleanup branches accumulate as worktree debt. Also needs an unbuilt priority-lane and a per-rule baseline store. No consumer. |

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where to inject the spec | Append to `appendSystemPrompt` beside the existing primer (`squad-manager.ts:3232`) | Minimal; reuses the proven injection point; no on-disk file mechanism needed (optionally also write `.omp/task.md` for audit) |
| Trust boundary on the body | Sanitize (HTML→markdown, strip scripts) + fence as untrusted **data, not instructions** | The body is human/skills-MCP-writable → live prompt-injection path into a `yolo` agent. Red team A's critical catch. Reuse the existing `fenceUntrusted` primitive |
| How to split gate stages | Split at the **source** in `detectVerify` (`intake.ts`) **before** it `.join(" && ")`s | A naive `&&`-string re-tokenize loses `cd`/`export`/quoted-`&&` semantics → silent bad-land. Splitting where the list is still structured is safe |
| Do stages drive the grade? | **No** — `Proof.stages[]` is observability-only | `DoneProof` grade is set elsewhere; threading stages into it is out of scope. Do not claim the grade "considers stages" (it can't without more work) |
| Defaults | Stage-split on by default (same commands, same order, just instrumented + fail-fast); spec-injection on by default (fixes a defect); scorecard shadow/deferred | Stage-split and spec-injection are strict improvements, not risky new gates |

## Risks addressed

| Concern | Severity | Resolution |
|---|---|---|
| Prompt injection via materialized body | critical | sanitize + fence as untrusted data; treat promoted Tier-2 vs raw intake bodies the same (both untrusted) |
| `&&`-split silent bad-land | critical | split at the structured source, never re-tokenize the joined string; keep single-exec fallback if a repo's verify is a custom opaque string |
| "materialize" no-op unless referenced | significant | inject into the prompt (`appendSystemPrompt`), not just a file on disk |
| Dispatch coupled to Plane fetch latency | significant | body travels on `IssueRef` from where the concern is already parsed (no new synchronous Plane fetch on the dispatch loop); title-only fallback on absence |
| stages can't influence grade | significant | scoped as observability-only by decision above; no grade claim |
| scorecard false-red before signals exist | significant | deferred; and when built, split hooks (instructions/tools at 3238, env/state after worktree cut 3381), threshold-gated, off the shared attention kind |

## Sequencing

01 before any 03 (03's "instructions" signal is exactly what 01 fixes). 02 is independent (gate/proof
path, no overlap with 01's dispatch/context path). Build 01 then 02; 03 is written but left `open`.
