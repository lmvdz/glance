# Design: policy-as-data + pre-execution gates (research #2 + #3)

## Outcome

Two research concepts, one plan, because they share a vocabulary (not a seam):
- **#2 policy-as-data:** glance's fencing is hardcoded (`agent-guard.ts`'s 8 regexes). Make it DATA an operator can add to at runtime to TIGHTEN a live fleet.
- **#3 pre-execution gates:** cost + blast-radius are checked BEFORE an unattended land/dispatch, not logged after — so "run the fleet overnight" is safe.

North-star fit: both raise how much can run **hands-off** by making the boundary explicit and testable, and give the operator a live **step-in** lever (tighten a misbehaving unit without killing it).

## The honest scope cut

There is **no single enforcement seam.** #2 fires in the *agent process* at `tool_call` (`lease-hook.ts:75` → `screenToolCall`, returns `{block,reason}`); #3 fires in the *daemon* at land (`LandResult{ok:false}`) and dispatch (park/throw). They share exactly three things and nothing more: a **policy-data home**, one **pure `evalPolicy`**, and the **ALLOW/DENY/ASK vocabulary**. One evaluator, three thin adapters — not a grand unified gate.

**Tighten-only is made unrepresentable-to-violate:** the rule schema has only `deny`/`ask` decisions (no allow-rules). Base state is allow; a rule can only *subtract* capability. No tier machinery needed to guarantee the invariant in v1.

**ASK is seam-specific** (verified against the code): a `PendingRequest` round-trip exists but only for a *live* agent — a daemon-side synthetic one **black-holes** (no waiter; the cmux red-team lesson). So: tool-call ASK degrades to DENY-with-soft-reason (no cross-harness mid-tool human prompt for omp/pi); land ASK = block auto-land, leave the human Land button (a *true* ask); dispatch ASK = park + report.

## Approaches (v1 core)

| | Ships | Why |
|---|---|---|
| A. Land blast-radius gate (**C-LAND**) | v1, **first** | Land is the one dangerous unattended action (touches main). Facts (`staleBranchReason`-style diff) + block shape (`LandResult`) + force-escape (mirror `validatorOverride`) all exist. Daemon-local, no store dependency — ships on env thresholds alone. |
| B. `PolicyStore` + `evalPolicy` (**C-STORE**) | v1 | Small shared substrate: a `stateDir/policy.json` sibling cloning `RuntimeSettingsStore`'s durable load/save, an Effect `Schema` for the rule table, one pure evaluator. Fail-open to `{rules:[]}`. |
| C. Data-driven deny/ask at tool-call (**C-RULES**) | v1 | The #2 headline: `screenToolCall` consults the table *in addition to* the hardcoded list; a POST endpoint (cloned from `/api/settings/feature-flags`) lets an operator add a deny rule → live fleet tightens. Per-`tool_call` read behind an mtime cache. |
| D. Cost projection (**C-COST**) | v1, **shadow-only** | Reuse `modelOutcomes` (sync land-rate) + `buildScoreboard` (`costPerLandedChange`). Ships `off\|shadow\|enforce`, default off; `enforce` deferred (needs an O(1) $ ledger; `readAllReceipts` is an async full scan). |

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Rule shape | `{ id, decision: "deny"\|"ask", when: {seam?, tool?, commandMatches?, pathMatches?, minDiffFiles?, minCommitsBehind?}, reason }`; present fields AND-match, absent = wildcard | Structured match objects, no CEL, no dependency. DENY-wins on multi-match; no match → allow. |
| Policy home | New `PolicyStore` → `stateDir/policy.json` (NOT folded into `settings.json`) | Schema is arrays-of-objects not `Record<Key,bool>`; the agent process must read it cheaply without the feature-flag machinery. |
| ALLOW/DENY/ASK | Support deny+ask decisions; ship **no allow-rules**; ASK is seam-specific (above) | Tighten-only by construction; honest about the missing mid-tool round-trip. |
| Shared code | one `evalPolicy(rules, subject) → {decision, reason, ruleId}` + 3 adapters, each try/catch → **throw = ALLOW (fail-open) + log** | Honest "no shared seam"; a misconfig never bricks the fleet. |
| Cost noise | require `landed+rejected ≥ OMP_SQUAD_COST_MIN_SAMPLE` before the gate may even ASK; whole gate shadow-first | Thin history stays silent, not wrong. |
| Fail-open | empty/missing/malformed policy → base allow, and the **hardcoded** `FORBIDDEN_COMMANDS`/protected-root checks STILL run — v1 never ships fewer protections than today | Constraint #1. |
| Gating | `OMP_SQUAD_LAND_RISK_GATE`, `OMP_SQUAD_POLICY_RULES` (new `FeatureFlagKey`s, `defaultEnabled:false`); `OMP_SQUAD_COST_GATE=off\|shadow\|enforce`; thresholds via `envInt` | Default-off rollout, template `OMP_SQUAD_REGRESSION_GATE`. |

## Risks

| Risk | Resolution |
|---|---|
| C-LAND false-positives erode trust (blocks a big-but-fine land) | Default-off; thresholds tunable; blocks only UNATTENDED auto-land — the human Land button bypasses via `riskOverride` (mirrors `validatorOverride`). Blast-radius is a DIFFERENT axis from the stale gate (overlap) / regression gate (post-merge tests) — not duplicative. |
| Live-tightening needs the agent process to read `policy.json` per tool_call | State-dir path is derivable there via `protectedStateRoots(home)` (`lease-hook.ts:70`); read behind a cheap mtime cache so a hot tool loop doesn't stat-storm. |
| Daemon-side ASK black-holes | Never raise a daemon `PendingRequest`; park + `AgentReport`. |
| `FeatureFlagKey` is a closed union | New flags added to `runtime-settings.ts:6` + `FEATURE_FLAGS`, else `isFeatureFlagKey` rejects them. |

## Scope boundary

**v1:** C-LAND (first, shipped this pass) + C-STORE + C-RULES + C-COST(shadow). All fail-open, default-off.
**Deferred epic:** the 3-tier per-org session→agent→server stack with cross-tier DENY-wins (RuntimeSettingsStore is global-only → per-org policy stores + tier composition are net-new — v1's flat table is the base tier); the true mid-tool ASK round-trip via ACP `session/request_permission`; enforce-mode cost (needs an O(1) $ ledger); a policy-editing UI (v1 mutates via one POST endpoint).
