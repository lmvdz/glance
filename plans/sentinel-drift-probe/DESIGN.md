# Design: Sentinel v0 — wrong-direction drift probe

_Keystone from the Global Workspace / J-space research (plans/research-global-workspace/BRIEF.md). Scope set by an adversarial design pass (Designer → 2× Red Team → Arbiter); the original six-kind "Sentinel" epic was cut to a single default-off probe._

## Approach
A cheap reasoning-lens, **folded into Scout's existing mid-run scan** (one transcript read, two lenses), detects one drift kind — **wrong-direction** (work trending away from the unit's declared acceptance criteria). Its hypotheses flow to an **action-free sink**; a hypothesis is confirmed by **reusing the existing independent judge** (`validator.scoreAgainstCriteria` on the working-tree diff — the same computation `convergence-run.ts realValidate` already does) and the result is appended to a **durable, off-Plane drift-audit log**. There is **no surface row, no steer, no escalator, no ledger** in this cut. The whole point of v0 is to produce one number — the monitor's judge-confirmed precision — that gates whether any of the deferred machinery is ever built.

The interpretability contract that justified the feature (MONITOR that measures ≠ JUDGE that rules ≠ INTERVENOR that acts, so a behavior change can be attributed to the intervention) is preserved but correctly scoped to the **one** drift kind it actually governs. Scout remains a filer; the drift lens is a separate pure module; the judge is a separate independent computation; the intervenor does not exist yet.

## Key Decisions
| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Plan scope | wrong-direction probe **only**, default OFF | six-kind epic; guardrails-only; both in one plan | The interpretability framing authorizes exactly the LLM-judge case = wrong-direction. Other kinds are deterministic guardrails or unconfirmable — a different feature (split to a sibling plan). |
| Read location | **Fold the read into Scout** (one cursor, one cadence); drift lens is a separate action-free module | own sibling class + own cursor; share Scout's timer | Purity governs where *action* lives, not where *reading* happens. Co-locating the read dissolves the cursor-steal race by construction (no second consumer) and halves transcript-read overhead. |
| Arbiter family | Collapses to **one arbiter**: the criteria judge | Designer's 4-member family (criteria + scope + proof-state + human) | proof-state is a category error mid-run (`verificationState` is "none" until a proof event → would confirm every skip-verify). Scope check needs net-new committed-vs-working-tree plumbing → moves to the sibling guardrails plan. |
| Machinery | **None** — monitor emits → judge confirms → append to audit. No escalator / ledger / re-judge / steer | Designer's full escalator + expiring ledger + routed abstain/veto/pass | Defer until precision is known. The judge call *does* ship (it produces the precision label), so the runId turnover guard is in-scope. |
| Surface | **No surface** in v0. Durable audit record ships; ephemeral alert deferred | ephemeral rows day one; on-in-shadow default | Default OFF; v0 is judge-only-to-a-record. Separating the durable record from a (later) alert preserves caught-near-miss + flapping signal. Invariant: drift never feeds `confidence.ts`. |
| Unit gate | Monitor only units **with declared acceptance criteria** (+ env gate) | monitor all units; wait for task-class tiering | Without criteria the judge returns "skipped" (nothing to confirm against), and criteria-less units are the ad-hoc/mechanical ones that manufacture false positives. This is a code-grounded eligibility signal, no tiering dependency. |
| Judge | **Reuse** `scoreAgainstCriteria` on a working-tree diff | build a parallel diff path in the monitor | It already computes exactly this (`realValidate`, convergence-run.ts:238-254). The monitor (reasoning lens) is the only genuinely new compute. |

## What ships in THIS plan (v0, `OMP_SQUAD_SENTINEL=0` default-off)
- A pure drift lens (`src/drift-lens.ts`): `Hypothesis{kind:'wrong-direction', severity, agent, runId, evidence, rationale, at}`, `buildDriftPrompt(task, criteria, reasoning)` + `parseDriftHypothesis(raw)`, its own `ScoutCallBudget` instance + env gate — action-free (no validator/steer/manager imports).
- A durable drift-audit log + confirm path (`src/drift-audit.ts`): append-only `<stateDir>/sentinel-audit.jsonl` (mirrors `receipts/*.jsonl` / `automation.jsonl`); `confirm()` = runId turnover guard → `scoreAgainstCriteria(criteria, workingTreeDiff)` → append `{runId, agent, kind, hypothesis, evidence, judgeVerdict, ts}`.
- Fold into Scout's `scan()` on the same cursor-advanced slice; `monitorEligible(unit)` = has declared `acceptanceCriteria` AND not env-denied; manager wires the action-free `onHypothesis` sink → confirm + audit, passing criteria + worktree + runId from the record.

## Explicitly deferred (and why)
- **Deterministic landing-readiness lints** (scope-creep filter, proof-state at landing) → own sibling plan. Higher value, zero LLM, but not this keystone; needs net-new working-tree name-only plumbing.
- **skip-verify / false-pass / thrashing kinds** → no mid-run confirming arbiter; the fleet already produces thrashing/large-diff behavior a naive detector misreads. Revisit after wrong-direction precision is proven.
- **Surface rows, SentinelEscalator, expiring active-drift ledger, park/re-judge, steer()** → stage 1+, gated on the v0 precision number.
- **Combined single-prompt lens** (true spend-halving) → optimization after correctness; v0 uses a separate budget-gated call sharing the read.

## Risks
| Risk | Mitigation |
|---|---|
| Monitor precision unknown (whole justification is temporal early-warning) | That's the experiment; v0 costs only a folded-in read + a reused judge. Poor precision → delete, don't promote. |
| Judge fires after `finalizeRun` tore down the run | runId turnover guard before the judge call and before the record write. |
| Two LLM classifications per scan raise fleet cost | Separate `ScoutCallBudget` instance so drift can't starve Scout's backlog scan; per-hour cap bounds spend. |
| Eligibility too coarse | Criteria-presence gate is conservative (fewer units, cleaner number); env allowlist/denylist as escape hatch. |

## Red Team Concerns Addressed
| Concern | Severity | Resolution |
|---|---|---|
| Arbiter family really 1 judge + filters; proof-state is a mid-run category error | significant | Collapsed to the criteria judge; proof-state dropped; scope filter → sibling plan; 3 kinds deferred. |
| Cursor-steal two-`setInterval` race | significant | Dissolved by folding the read into Scout — one cursor, one consumer. |
| Sweep-vs-`finalizeRun` race | significant | runId turnover guard (judge ships in v0, so guard is in-scope). |
| Marginal value thin → ship wrong-direction-only | critical | Adopted as the whole plan; six-kind epic cut. |
| "Severity gates spend not surface" | significant | Moot in v0 (no surface); becomes the stage-1 rule. |
| Ephemeral rows lose near-miss/flapping | significant | Durable append-only audit record ships; ephemeral alert deferred. |
| Default on-in-shadow still ships noise | minor(blocking) | Default OFF; v0 is judge-only-to-record. |
| realValidate already computes this → reuse | critical | Judge reuses `scoreAgainstCriteria`; monitor is the only new compute. |
| Pre-tiering false positives on mechanical units | significant | Criteria-presence eligibility gate ships in v0. |

## Open Questions — all resolved before decompose
- **Unit-kind signal** → use criteria-presence (no explicit complexity tag exists; the judge already "skips" criteria-less units).
- **Audit-record home** → `<stateDir>/sentinel-audit.jsonl`, append-only, off the run record (survives teardown).
- **realValidate extraction** → none needed; `scoreAgainstCriteria` is already standalone.
- **Promotion threshold** → provisional ≥70% judge-confirmed over ≥2 weeks / ≥N hypotheses on eligible units (a policy number, recorded for stage 1's entry criterion).
- **One vs two lens calls** → two budget-gated calls sharing the read; combined-prompt is a later optimization.
