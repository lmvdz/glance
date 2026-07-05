# Design: Autonomous AI Fleet System (meta-plan)

## Approach

Build glance into the trust-first autonomous fleet in **seven epics**. The fleet already has strong *throughput* machinery — worktree-isolated dispatch, proof-gated landing, conflict auto-resolution, a mature insights/FleetPulse surface. The entire value of this plan is the *trust* layer that throughput-first systems skip and then spend forever retrofitting: independent validation, replayable audit, confidence-gated human-in-the-loop, and a learning orchestrator — tied together by a convergence loop that can run a meta-goal unattended **without amplifying its own errors**.

This is a **meta-plan**: each of the seven epics is itself decomposed into a sub-plan, recursively, until every leaf is a Sonnet-ready unit (see *Recursion Contract*). The docs at this level orient a staff engineer on direction and ordering; implementation detail lives in the leaf concerns of the child plans.

## The seven epics

1. **Resident planner** — a standing loop that ingests an objective and emits/updates a living concern-DAG (the inverse of `plan-sync.ts`). Today planning is 100% human-triggered.
2. **Execution roles** — specialize the general coding unit: wire the dormant testing agent (writes the acceptance test *before* the coder) and promote the Observer's reproduce logic into an observing agent.
3. **Independent validator** — *the critical path.* A separate agent with veto that scores output against declared `acceptanceCriteria` — never the executor grading its own self-authored test. Plus a compliance agent over the existing ledgers.
4. **Replayable traceability** — un-sample and turn on the trace subsystem; weave the three append-only streams + transcripts + orchestration decisions into one causal chain; surface it in the already-built FleetPulse/provenance UI.
5. **HITL safeguards** — first-class confidence scoring; a confidence *trigger* on the already-existing propose-only (`assist`) autonomy mode; an exception-triggered steering lane; a non-blocking report primitive.
6. **Learning orchestrator** — execute the designed-but-unbuilt `agentic-learning-loop`, then add *outcome-driven* model assignment and confidence-threshold tuning on top.
7. **Convergence loop** — the capstone: `plan-against-verified-state → implement → independently-validate → ratchet-gate → escalate-on-low-confidence`, driven by a Stop-hook auto-continuation so the loop stays cache-warm. Depends on 1/2/3/5/6.

## Prior art — reference and depend, do NOT re-decompose

| Plan | State | Relationship |
|---|---|---|
| `inspectable-topology` | CLOSED | Delivers durable lineage + workflow-graph journal — Epic 4 substrate. |
| `lifecycle-truth` | CLOSED | Trustworthy transition timeline wired into `insights.ts` — Epic 4/5 substrate. |
| `factory-control-plane` | Partial | Proof-before-land, autonomy-mode contract, durable event journal for replay — Epic 3/6 groundwork. |
| `agentic-learning-loop` | Open (5/5) | *Is* Epic 6's substrate; Epic 6 executes it, then extends. Respect its cuts. |
| `never-lose-work` | Mixed | Dead-end terminal handling + fork-from-checkpoint — Epic 2/7 substrate. |

## Key decisions (including ground-truth corrections from exploration)

| Decision | Choice | Rationale |
|---|---|---|
| Framing of Epic 4 | "Un-sample + turn on + weave", NOT "fix a broken exporter" | `trace-exporter.ts` is real and wired; it's off-by-default, fire-and-forget, and 90% sampled (`traceSampleRatio` 0.1). Not code-broken — a no-op in default config. |
| Validator independence | Separate agent, non-overridable, scores vs declared `acceptanceCriteria` | Root cause of truth-lies: `buildTddVerifyWorkflow` has the *same* agent author the acceptance test and implement against it; `proofGate` only checks a deterministic exit code and is human-overridable ("or force"). A loop around a self-grader amplifies lies. |
| Propose-only mode | A *trigger*, not a build | `autonomy.ts` already models `observe|assist|autodrive`; `assist` IS propose-only. Missing piece = cap the mode by confidence in `maxEffectiveMode`, parallel to the existing `blockedReason→observe` rule. |
| Testing-agent role | Wire the dormant `buildTddVerifyWorkflow` | Fully built + tested, referenced only in tests; `routeIntake` never selects it. Epic 2 is mostly wiring, not construction. |
| Data-driven model assignment | *Outcome*-driven (landed-vs-rejected per model×complexity), boost-only, never a land gate | `agentic-learning-loop` explicitly cut *capability-match* routing as a category error and kept reward boost-only with deterministic proof as the sole gate. Epic 6 must not re-open that. |
| Loop drive mechanism | Stop hook (auto-continue on turn end), NOT cron/`ScheduleWakeup` | Interval loops re-read the whole conversation uncached every fire (5-min cache TTL). A Stop hook that denies the stop and re-injects a continuation keeps cache warm and preserves in-context working state. Arm-gated + budget-capped. |

## Recursion contract — the definition of a Sonnet-ready leaf

A concern is a **leaf** (stop recursing, hand to a Sonnet implementer) if and only if **all** hold:

- **Complexity** is `mechanical`, or `architectural` but scoped to a single coherent change set one agent can hold in context.
- **TOUCHES** names concrete, verified-to-exist file paths — roughly ≤ 6 files.
- **Acceptance test** is a concrete command + expected observable outcome (a behavior to drive), not a vibe.
- **Scope boundary** is explicit (what NOT to touch).
- **Zero unresolved design decisions** — every judgment call was already made by a parent node.

Otherwise the concern is a **branch**: give it a `SUBPLAN:` pointer to a child `plans/meta-autonomous-fleet/<epic>/` directory and decompose it there, repeating the contract. Each epic concern in this directory is a branch by construction; its `## Decomposition seed` lists the grounded candidate leaves the recursive decomposer starts from.

## Risks

| Risk | Mitigation |
|---|---|
| Loop amplifies lies if run around a self-grader | Hard dependency: Epic 7 blocked by 3 (validator) and 5 (confidence exit). Never loop before both exist. |
| Validator adds LLM cost/latency to every land | Run only on `goalGate` nodes; sample + cache; deterministic proof still runs first and cheaply. |
| Warm loop hits the context-window ceiling | Not one immortal session — long warm sessions chained by a clean handoff seeded with the verified-state doc. |
| Outcome-driven model routing overfits / penalizes | Boost-only, never a land gate; reuse the learning-loop's "absence = unknown, never penalize" rule. |
| Meta-goal under-determines the space → drift | Externalize the definition of done as a checkable acceptance spec the validator scores against; the loop diffs against a fixed target, not a fresh opinion each iteration. |

## Ordering (detail in `00-overview.md`)

Trust foundation first: **3 (validator) + 4 (traceability)** in parallel. Then **2 (roles) + 5 (HITL)**. Then **1 (planner) + 6 (learning orchestrator)**. Then **7 (convergence loop)** as the capstone once its dependencies exist.
