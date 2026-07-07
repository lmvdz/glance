# Design: Perspective-diversified review (out-of-criteria lens) for the land gate

## Outcome

The land gate gains a **second, orthogonal review axis**: today's authoritative criteria judge
grades *only the declared acceptance criteria* (`src/validator.ts:80` — "satisfied only if the
diff visibly implements it"), so a regression the criteria never *named* — a security hole, a
perf cliff, a scope violation — is structurally invisible to it. This ships an **advisory
out-of-criteria lens**: an independent, focused judge that hunts exactly the class of problem the
criteria judge is told to ignore, fires only on risky diff surfaces, and lowers the run's
confidence (holding the auto-land for operator approval when the confidence floor is enabled)
without ever moving the single authoritative veto. Default-off, fail-open, shadow-first.

This is the **perspective** axis, complementary to the already-shipped **vendor** axis
(cross-lineage review). The two compose: the lens can itself run cross-vendor via
`activeReviewer()`.

## Approach

A focused lens judge is added **sequentially after** the authoritative criteria judge inside
`validatorGate`, not concurrent with it (see Decisions — the concurrent variant was rejected as
a fail-open landmine). The criteria judge runs first and alone, exactly as today; if and only if
its verdict is neither `veto` (already blocked) nor `abstain` (judge was unreachable — adding a
second opinion on an unvalidated land is meaningless) *and* the diff surface is risky (not
docs/config-only), one lens judge runs on the same `computeLandDiff` output, reusing the exact
`decideTyped`/`omp -p` machinery the criteria judge already uses.

The lens is prompted to find problems the declared criteria do **not** mention. Its verdict is
advisory: it lands on a new `ValidationRecord.lensAdvisory` field and feeds `scoreConfidence`,
which already flows to `dto.confidence` and the auto-land **hold** gate (`confidenceBelowFloor`,
`squad-manager.ts:2430`). A high-severity objection triggers **one** narrow re-check (the VERIFY
branch) scoped to that single claim. A confirmed objection maximizes the (small) confidence
penalty and sets a review-needed flag — it never vetoes.

**Shadow-first is the core discipline.** v1 ships one lens with catch-logging so the operator can
measure, over real lands, whether it catches defects the criteria judge missed — *before* any
pool of additional lenses (perf, architecture, testing) is built. The premise that a focused
lens out-performs a reworded monolithic judge is unproven; v1 is the falsifiable experiment, not
the framework.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Sequencing vs the authoritative judge | Criteria judge runs **alone, first**; lens fires **after**, only on non-veto/non-abstain | Concurrent `Promise.all` ("latency = max not sum") | Concurrency co-locates N+1 `omp -p` spawns at the criteria judge's moment of need; a provider 429 / resource exhaustion could make the *authoritative* judge time out → fail-open `abstain` → a would-be-vetoed change lands. The advisory feature must never be able to degrade the authority. Sum-latency is the correct trade. |
| Failure isolation | `Promise.allSettled` for any multi-lens future; each lens call + **its parser** wrapped so a throw → `undefined` (no signal) | `Promise.all` | `decideTyped` does **not** guard `opts.parse()`; a throwing lens parser inside `Promise.all` rejects the aggregate → `validatorGate` throws → the land throws = fail-**closed**, the one forbidden outcome. |
| What the lens looks for | Problems the **declared criteria don't mention** (out-of-criteria regressions), starting with the security/refute framing | A generic "is this good" lens; mirroring the criteria judge's per-criterion scoring | This is the *only* place a focused judge structurally beats the monolithic one — the criteria judge is explicitly scoped to declared criteria. Anything else is asking the same model the same question in a different font. |
| Scope of v1 | **One** lens, shadow-mode with catch-logging; pool (perf/arch/testing) **deferred** until shadow data shows real catches | Ship the full 5-lens pool now | Build and prove the primitive before generalizing. The pool multiplies unproven value by N and doubles the cost objection. |
| Disposition: advisory vs authoritative | **Advisory** → `scoreConfidence` → auto-land **hold** (stage for operator) when the floor is enabled; never a veto | RT alternative: inject a synthetic criterion into the existing judge so the existing **veto** handles it | Advisory is fail-open by construction and preserves the single authoritative veto (the #3 hard constraint). Making an *unproven* reviewer authoritative moves the trust floor. **Criteria-injection is the documented promotion path** once shadow data proves catches — not v1. |
| Behavioral lever | The confidence penalty reaches a *real* gate: `confidenceBelowFloor` (`squad-manager.ts:2430`) reads `dto.confidence` (the `scoreConfidence` output, set at `:4973`), holding a low-confidence auto-land for operator approval | (Belief that confidence is pure telemetry) | Verified against code: the floor gate is real but flag-gated (`OMP_SQUAD_CONFIDENCE_FLOOR`, off by default). So v1 changes autonomous behavior *when an operator enables the floor* — and is inert-but-recording otherwise, which is the correct shadow posture. |
| Lens selection (#2) | Pure, no-LLM `selectLenses(files, criteriaText?)` reusing `land-risk.ts` `RISKY_PATH_RE` + blast-radius and `intake.ts` `HIGH_RISK`; docs/config-only → `[]` (fall back to today) | LLM router; always-on | Zero-cost, deterministic, testable. Note the honest limit below. |
| VERIFY trigger + gating | Only `severity:high` + `object` → one narrow re-check; structurally **nested under the master flag** (unreachable when off), own sub-flag only toggles *within* an enabled panel | Any objection triggers VERIFY; VERIFY flag independent of master | Bounds added cost to ≤1 extra call, only when warranted; prevents a live spawn with the master feature off. |
| Lens verdict caching | Cache-miss-only; key `${commit}:${tree}:${lensId}:${criteriaHash}` | Reuse `gateCache` as-is; key without criteria hash | The lens *selection and prompt* depend on criteria/task text; dropping the hash serves a stale verdict when criteria change. Cache must be written into the record before `gateCache.set`, and the record treated immutable after. |
| Confidence math | New `ConfidenceInput.lensAdvisory: "clean"|"objected"|"confirmed"` weighted +0.05/−0.15/−0.25 (all below primary ±0.1/−0.4); result **clamped [0,1]** | Same weight as primary; no clamp | Keeps "advisory" true in the numbers; clamp because same-lineage + lens penalties can otherwise stack past the bound. |
| Flags | `OMP_SQUAD_LENS_REVIEW=1` (master, off); `OMP_SQUAD_LENS_SET` (CSV debug); `OMP_SQUAD_LENS_MAX` (default 1 for v1); `OMP_SQUAD_LENS_TIMEOUT_MS` (default 60s, < criteria 120s); `OMP_SQUAD_LENS_VERIFY=1` (within-panel) | Single on/off | Mirrors the `OMP_SQUAD_VALIDATOR_HARNESS` rollout pattern. |

## Risks

- **Fail-open on the authority (critical, from RT1).** The sharpest edge. Resolved by sequencing
  the criteria judge alone/first and never placing it in the lens batch; plus a test asserting a
  throwing/timing-out lens leaves the criteria record intact and the land proceeds exactly as
  today.
- **Signal vs theater (from RT2).** A same-model lens may add framing-diversity but not the
  vendor-diversity blind-spot escape. Mitigations: (a) scope the lens to out-of-criteria, the one
  real gap; (b) ship in shadow mode with catch-logging so the premise is *measured*, not assumed;
  (c) allow the lens to run cross-vendor via `activeReviewer()`. Shipping with zero cross-vendor
  override is a known, accepted framing-only gap, called out to the operator.
- **Cost (from RT2).** `RISKY_PATH_RE` includes every lockfile, so most non-docs lands are
  "risky" — the lens will fire often. v1 caps at 1 lens; the shadow log surfaces per-land spend
  via the existing harness attribution ledger so the cost is visible, not discovered on an
  invoice.
- **Docs-only fallback misclassification (from the designer).** A "docs" change that is actually
  an executed prompt file gets no lens. Bias: when a diff is mixed, treat it as risky, not docs.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| RT1: concurrent panel starves the authoritative judge → fail-open abstain | critical | Criteria judge runs alone/first; lens strictly after. |
| RT1: "concurrent AND gate-on-verdict" is contradictory | significant | Committed to sequential. |
| RT1: throwing lens parser → `Promise.all` rejects → land fails-closed | significant | `allSettled` + guarded parser; criteria judge never in the batch; explicit test. |
| RT1: cache-hit skips or double-runs the panel; shared-ref mutation | significant | Cache-miss-only; merge into record before `set`; record immutable after. |
| RT1: lens cache key omits criteria/task text it depends on | significant | Key includes `criteriaHash`. |
| RT1: VERIFY sub-flag "independent" can fire with master off | significant | VERIFY structurally nested under master; test: master off + VERIFY on ⇒ zero spawns. |
| RT1: confidence can stack past [0,1] | minor | Clamp in `scoreConfidence`. |
| RT2: lens split adds no signal over a reworded single judge | significant | Scoped to out-of-criteria (the one real gap); shadow-first with catch-logging to measure before generalizing. |
| RT2: confidence path is inert telemetry | significant (partly refuted) | Verified: it reaches the auto-land hold gate; flag-gated off by default = correct shadow posture. |
| RT2: pool is scope inflation over an unproven primitive | significant | v1 = one lens; pool deferred behind shadow evidence. |
| RT2: advisory-that-never-blocks changes no hands-off outcome | significant | It changes the auto-land→hold outcome when the floor is enabled; criteria-injection/veto is the documented promotion path once proven. |

## Scope boundary

**Ships (v1):** the pure lens selector, one out-of-criteria lens judge on `decideTyped`
(cross-vendor-capable), sequential wiring after the criteria judge (fail-open, allSettled,
cache-correct), advisory→confidence-hold integration (clamped), the VERIFY re-check nested under
the master flag, the flag surface + default-off test + shadow catch-logging. All default-off.

**Deferred (behind shadow evidence):** the multi-lens pool (perf, architecture, testing); the
promotion path to criteria-injection/veto; UI surfacing of `lensAdvisory`/`lensVerify` in the
Land view (PR #67 trust-legibility precedent).
