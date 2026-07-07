# Design: Model-routing control loop (omp-squad)

Origin: `/research` of Devin "Fusion" → `plans/research-devin-fusion/BRIEF.md`. Adversarial design (designer → 2 red teams → arbiter) rejected the naive two-arm shape; this is the resolved plan.

## Approach

A staged **observe → learn → act** loop, not a build-everything-at-once feature.

- **Observe first (C01–C05):** ship a `task-class × model` outcome matrix as an *explicitly labeled, non-causal observability surface*. It answers "what did the router pick, and what happened after it landed" — honestly, including the failures. It is **not** trusted as a routing input until three data-integrity fixes land inside it.
- **Act second (C06):** the control loop's action arm is the model router that **already exists** — `shiftedModel` in `src/smart-spawn.ts` — enriched to key on the matrix's `(task-class, difficulty)` signal and wired onto the **dispatch** path (where it currently never runs). Up-front routing at dispatch, gated and shadow-first.
- **Deferred (D1, D2):** epsilon-random exploration (prerequisite for ever *regenerating* policy from the loop's own evidence) and mid-run difficulty escalation (Fusion's headline, but a no-op and matrix-corrupting as first drafted — deferred behind hard prereqs).

The two original concerns morphed under adversarial review: Concern #1 (scoreboard) stays but ships truthfully-labeled; Concern #2 (mid-run escalation) is **replaced** in v1 by up-front routing off the same data, because the existing `shiftedModel` gets ~80% of the value with full coverage, clean attribution, and none of the mid-run fragility.

## System boundary

Touches the daemon's dispatch/land/receipt/attribution paths (`src/squad-manager.ts`, `src/receipts.ts`, `src/model-outcomes.ts`, a new `src/omp-graph`-sibling aggregator, `src/smart-spawn.ts`) and the read surface (`src/server.ts`, `webapp/src/lib/insights.ts`). No new dependency — every seam already exists. Requires a daemon restart to take effect (the daemon runs the global install).

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| #1: observability vs decision input | **Staged** — ship labeled-observability, graduate to decision-input behind C01/C02/C04 | Un-fixed, the matrix folds every fleet unit into one "default/unknown" model bucket and inflates merge-rate; trusting it would actively mislead |
| #2: mid-run escalation vs up-front routing | **Up-front routing (C06); mid-run deferred (D2)** | Mid-run predicate is dead by default, needs a `getModel()` that doesn't exist, and mis-attributes escalated lands to the cheap tier — poisoning #1. Up-front covers `RpcAgent` too and attributes cleanly |
| Task-class definition | Router's `{mode, tier}` is a **grouping axis**; difficulty truth is an **independent post-hoc signal** (`filesTouched`, diff LOC, `visits.fixup`) | `tierOf(thinking)` and `verifyMode` are both router outputs — grading the router by its own labels is circular |
| Effective-model capture | Read `frame.message.model` on RPC assistant frames (already on the wire) | No upstream omp change needed for the dominant path; ACP/codex has no output model → best-effort/deferred |
| Merge-rate denominator | The durable `PersistedAgent` roster (`state.json`), filtered to landing kinds | Receipts structurally omit units that die before finalize (the units-never-commit worst-failure class); the roster is written at create |
| Non-landing exclusion | New `isLandingUnit()` helper: exclude `flue-service` kind, `observer` role, `observe` autonomy mode, `observe` verifyMode | Those never produce a PR; counting them as failures would be a lie |
| Join key / idempotency | Key rows on `agentId`, upsert last-terminal-wins; maintain `branch→agentId` index for the branch-keyed land + reconciler paths | `land()`/`recordLandOutcome` are branch-keyed and the reconciler has no agentId; without the index the row double-counts |
| `rework-rate` | In-run `visits.fixup` churn, **labeled "in-run, not post-merge"** | No landed-then-reverted signal exists anywhere; honest proxy or nothing |
| median-cost | Surface with an explicit coverage % + N; never gate routing on it | `costUsd` is null for most fleet (subscription-priced) runs |
| exploration | Documented **prerequisite** for policy-regeneration; not built | Pure observation needs confounding *labeled*, not randomized; self-optimization needs epsilon |

## Risks

1. **ACP/codex units stay model-dark.** Effective-model capture works for RPC only; codex-run units keep an unknown model axis until the ACP driver is extended. Mitigation: C06 sets an explicit model on routed units, so anything the loop *acts* on is attributable regardless of harness.
2. **Create-handshake crash leak.** A unit that dies between construct and the create-time persist (`squad-manager.ts:3184`) leaves no roster row, so it escapes the denominator. Small, documented; acceptable for a control loop.
3. **Circularity until exploration lands.** Even with an independent difficulty signal, the matrix only ever sees choices the router made. It is safe to *observe* and *conservatively boost* (MIN_SAMPLES-gated), but must not *regenerate* policy until D1. Enforced by labeling + the env gate, not by hope.
4. **Load-bearing file churn.** C02/C03/C06 edit `src/squad-manager.ts` (a large, central file). Concern boundaries are drawn to keep edits to distinct call sites; execution must isolate per-concern.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| Model axis empty on dispatch path | Critical | Addressed — read `frame.message.model` (C01), guaranteed on routed units (C06) |
| Denominator excludes worst failures / includes non-landing kinds | Critical | Addressed — roster-anchored denominator + `isLandingUnit` (C02) |
| Circular/confounded, no counterfactual | Critical | Split — independent difficulty signal now (C04); exploration deferred (D1) |
| Escalation predicate dead by default | Critical | Addressed by removal — mid-run out of v1 (D2) |
| `getModel()` missing / non-ladder families | Critical | Addressed by removal — up-front sets model at dispatch (C06) |
| Escalation corrupts the matrix (created-with attribution) | Critical | Addressed by removal; D2 prereq = terminal-model + escalated tag |
| Coverage inverts need (RpcAgent uncovered) | Significant | Addressed — up-front router covers dispatch incl. RpcAgent (C06) |
| Cost/confidence/model from different runs | Significant | Dissolved — one run per unit with no mid-run swap |
| No idempotency key; reconciler has no agentId | Significant | Addressed — agentId key + branch→agentId index (C03) |
| land() guard drops outcome categories | Significant | Accepted-with-mitigation — roster counts missing rows as failures (C02/C03) |
| median-cost mostly null | Significant | Accepted-with-mitigation — coverage % + N, never a routing gate (C05) |
| Simpler up-front router already exists | Significant (headline) | Adopted as the action arm (C06) |

## Open questions

All four from the arbiter were resolved by code inspection before decomposition:
- Effective model on the wire? **RPC yes** (`frame.message.model`), ACP no. → C01 scoped to RPC.
- `PersistedAgent` persisted at create? **Yes** (`squad-manager.ts:3184`), one small handshake-crash leak. → C02 feasible.
- Non-landing kinds? Enumerated (`flue-service`/`observer`/`observe`×2). → C02 authors `isLandingUnit`.
- Rework signal? **None post-merge**; in-run `visits.fixup` only. → C04 labels it in-run.

No blocking unknowns remain.
