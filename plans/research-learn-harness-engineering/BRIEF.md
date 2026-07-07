# Research Brief: walkinglabs/learn-harness-engineering

**Date**: 2026-07-07
**Target project**: omp-squad / glance (meta-harness autonomous fleet at `/home/lars/sui/omp-squad`)
**Source**: https://github.com/walkinglabs/learn-harness-engineering (MIT, ~10k★, curriculum content — not a library)
**Pipeline**: TARGET → SCOUT → DISSECT (comparator/sonnet) → ABSTRACT (strategist/opus, fable rate-limited) → PERSIST

---

## Headline

`learn-harness-engineering` is a **12-lecture + 6-project curriculum** that distills the two canonical
industry harness posts (OpenAI's "Harness engineering: leveraging Codex in an agent-first world" +
Anthropic's "Effective harnesses for long-running agents" / "Harness design for long-running application
development") into a teachable discipline. Thesis: **strong models ≠ reliable execution — the gap is a
harness problem, not a model problem.** A harness = "all engineering infrastructure beyond the model
weights," decomposed into five subsystems: **instructions, tools, environment, state, feedback**.

**This is not a tool to adopt — it's a vocabulary and a gap-check.** glance has *independently converged*
on ~two-thirds of the curriculum (harness-over-model IS glance's thesis; evidence-gated completion,
external-oracle verification, cross-lineage review, context-boundary handoff, fleet observability all
ship today). Research value = the handful of foundational concepts the community-standard curriculum
names that glance has **not** shipped.

---

## Scout brief (facts)

- **Type**: VitePress curriculum site, 15 languages, MIT, created 2026-03-29. Not a framework; ships
  copy-ready templates + one installable `harness-creator` skill.
- **Founding anecdotes** (load-bearing throughout): (a) top agents hit ~50–60% on SWE-bench Verified and
  that's the *favorable* case (clear specs, ready tests); vague real specs collapse it. (b) Anthropic's
  controlled experiment — same prompt ("build a 2D retro game editor"), same model (Opus 4.5): bare
  harness → 20 min / $9 / broken; full planner-generator-evaluator harness → 6 hr / $200 / playable.
  "They didn't change the model… What changed was the tack."
- **12 lectures** (each "Why X fails" → minimal fix): (1) models ≠ reliability / five failure modes,
  (2) what a harness is / five subsystems, (3) repo IS the spec, (4) split instructions / router file,
  (5) cross-session context, (6) init as a phase, (7) task boundaries / WIP=1, (8) feature_list.json as
  primitive, (9) prevent premature victory, (10) full-pipeline verification, (11) runtime observability,
  (12) clean handoff / continuous cleanup.
- **Central primitive**: `feature_list.json` — one machine-readable ledger (statuses
  `not_started→in_progress→blocked→passing`, `passing` requires recorded `evidence[]`) that the
  scheduler picks from, verifier judges by, and handoff summarizes from. JSON Schema shipped.
- **`harness-creator` skill**: scaffolds + validates + **scores** a harness across the five subsystems
  (HTML assessment report). Honest caveat: "structural benchmark… real effectiveness needs before/after
  sessions."

---

## Comparator: transferable patterns (generalized)

| # | Concept | Transferable pattern | Non-obvious insight |
|---|---|---|---|
| 1 | Harness > model | Reliability is a property of scaffolding, not the checkpoint | Industry optimizes the axis (model) that isn't the bottleneck |
| 2 | Repo IS the spec | Materialize info inside the agent's reachable surface or it doesn't exist | External systems of record become liabilities for autonomous work |
| 3 | Proximity > length | Co-locate instructions with the code they govern | Relevance is spatial, not comprehensive |
| 4 | Instruction router | Thin index → deep leaves loaded on demand; bloat threshold ~10–15% of window | A *bigger* instruction file makes the agent *worse* (lost-in-the-middle) |
| 5 | Hard vs suggestions | Separate inviolable rules from advice into differently-weighted channels | Blending leaks constraint authority to suggestions |
| 6 | Finite context | Design for context exhaustion as the normal case; state lives outside window | 1M tokens moved the wall, didn't repeal it |
| 7 | Init as a phase | Orientation vs execution optimize opposite things | Reusing the impl mindset for startup produces cold-start errors |
| 8 | Fixed startup template | Deterministic boot + mirrored shutdown; fix baseline before new work | Symmetry (boot ≙ handoff) is the load-bearing trick |
| 9 | WIP=1 / attention | Concurrency dilutes per-task attention (C/k) | Multitasking is a *measurable* dilution, not a style choice |
| 10 | Small-next-step | Right-size scope down; volume of output is an anti-signal | LoC weakly *negatively* correlated with feature completion |
| 11 | One state-machine ledger | One artifact serves scheduling + verification + handoff → no drift | Scope control IS a data structure |
| 12 | Passing requires evidence | Status transitions gated on execution artifacts, not say-so | "Done" is a receipt, not a claim |
| 13 | Overconfidence | Route "am I done?" to an external execution-grounded oracle | Miscalibration is systematic (Guo 2017) — can't be prompted away |
| 14 | Three-layer termination | lint/typecheck → tests+startup → full user flow; all required, cheap-first | Green tests is a *middle* layer, not the finish line |
| 15 | Full-pipeline = verification | E2E is the only authoritative "works" signal | When the agent *knows* it'll be E2E-validated, its authoring shifts upstream — **the verifier shapes the author** |
| 16 | Observability = evidence | Make runtime inspectable; blind retries re-roll dice | Reframes reliability from "don't fail" to "make failure legible" |
| 17 | Progress records | Persist a running log so the next session inherits context | The cost isn't the writing, it's the re-diagnosis every session pays without it |
| 18 | Repo drift | Agents copy existing patterns even when suboptimal; hygiene is a control input | The spec and the drift source are the same object |
| 19 | Continuous cleanup | Golden rules (auto-checkable) + background refactor-PR fleet; capture taste once, enforce continuously | 20%-of-Friday batch cleanup doesn't scale with agent throughput |
| 20 | Minimal-first artifact | Grow the harness reactively from observed failures (failure→fix→artifact) | Anti-gold-plating: every artifact earns its place |
| 21 | Structural ≠ effectiveness | You can statically SCORE a harness's 5 subsystems | A well-formed harness can still be ineffective — completeness is necessary, not sufficient |

**Two design tensions underneath it all**: (1) the repo is simultaneously the spec *and* the primary drift
source; (2) completeness is auditable but effectiveness is not.

---

## Strategist: glance mapping (verified against real files)

**Verdict**: Actionable, but a *short* list — glance already built ~2/3 of the curriculum. Highest-value
gap: glance's fleet land-gate is a **single opaque command** (usually `bun test`/`tsc`), not a layered /
E2E "full user flow" gate — exactly the blind spot that spawned glance's own `make-it-work` loop and the
recurring "green tests lie" memory. The curriculum's non-obvious claim (an E2E-aware gate shifts the
*author's* behavior upstream) is a direct lever on glance's core trust problem.

| Concept | glance status | Evidence |
|---|---|---|
| Harness > model | SHIPPED (the thesis) | `src/harness-registry.ts`, `src/agent-driver.ts` |
| Repo IS the spec | SHIPPED | `src/fabric-search.ts:237 buildContextPrimer`, `src/concern-tickets.ts:30` |
| Proximity > length | GAP (minor) | no nested `AGENTS.md`/`ARCHITECTURE.md`; only a global primer |
| Instruction router | PARTIAL | root `AGENTS.md` is a 106-line doctrine file, not a thin router |
| Hard vs suggestions | SHIPPED | `AGENTS.md` "Always/Ask first/Never" + Non-negotiable list |
| Finite-context design | SHIPPED | `src/convergence-oracle.ts:76 handoffDoc`; cold-adopt in `squad-manager.ts` |
| Init as a phase | PARTIAL | cold-start primer + resume, but no explicit per-unit orientation ritual |
| Fixed startup template | PARTIAL | has the pieces, no deterministic per-unit boot script |
| WIP=1 / attention | Convergent (N/A as stated) | fleet is parallel-by-design; per-unit=1 concern/worktree; cap `src/dispatch.ts:112 maxWip` |
| Small-next-step / LoC anti-signal | PARTIAL | decomposes into units; no LoC-as-anti-signal instrumentation |
| **One state-machine ledger** | **PARTIAL (real drift)** | `src/features.ts` + plan STATUS + Plane + `src/done-proof.ts` = 4 ledgers |
| Passing requires evidence | SHIPPED | `src/done-proof.ts` (receipt, not claim) |
| Overconfidence / external oracle | SHIPPED | `src/convergence-oracle.ts`, `src/validator.ts scoreAgainstCriteria` |
| **Three-layer termination** | **GAP** | single `--verify <cmd>` (`src/index.ts:95`); no cheap-first layering |
| **Full-pipeline E2E** | **GAP** | no E2E/user-flow gate in the fleet path |
| Observability = evidence | SHIPPED | `src/automation-log.ts`, fleet-pulse, `src/drift-lens.ts` |
| Progress records | PARTIAL | strong for convergence loop; weaker per-dispatched-unit |
| Repo drift (pattern) | GAP | `drift-lens` tracks *goal* drift, not *pattern* drift |
| **Continuous cleanup / refactor fleet** | **GAP (planned, all open)** | `plans/self-extension-factory/*` STATUS: open |
| Minimal-first artifact | PARTIAL | `src/failure-memory.ts` exists; self-extension-factory is the planned version |
| **Structural harness scorecard** | **GAP** | nothing scores a unit's 5 subsystems before dispatch |

### Ranked gaps

**1. E2E / layered land-gate that shapes the author (concepts 14+15) — HIGHEST VALUE**
- **Pattern**: Gate "done" on the full user-flow pipeline, structured cheap-first (lint/typecheck →
  tests+startup → real end-to-end flow), all required. The load-bearing effect isn't catching more bugs —
  it's that when the author *knows* work will be E2E-validated, it authors upstream (interfaces, state,
  resource lifecycle, errors handled preemptively). The verifier shapes the author.
- **Mechanism**: Extend `src/gate-runner.ts` from a single `GateExec` to an ordered list of stages with
  fail-fast; make the *last* stage an actual flow-drive (glance already owns the machinery — the `verify`
  skill, `agent-browser`, the webapp under `OMP_SQUAD_WEBAPP=1`). Record each stage's receipt into
  `done-proof.ts` so `verified: "green"` means "E2E-green", not "tsc-green". Surface the gate contract in
  the unit's injected context so the author sees it up front.
- **Value for glance**: This is glance's *named, recurring* failure mode. The `make-it-work` loop exists
  precisely because units "exist but don't actually work" while tests are green; "UI lied ready-to-land on
  vetoed." A unit-test-only gate is the mechanism by which glance's autonomous landings lie.
  `done-proof.ts` already distinguishes `green | red-baseline | unverified` — it has the slot for a
  stronger proof grade; nothing fills it with E2E evidence today.
- **Where**: `src/gate-runner.ts` (stage list), `src/done-proof.ts` (grade/receipt),
  `src/convergence-run.ts realValidate` + `src/land-mode.ts` (invocation sites), `src/gate-env.ts`
  (already scrubs env per stage). Reuse `verify` skill + `agent-browser` as terminal stage.
- **Build vs Buy**: Borrow. All machinery (hermetic sandbox, proof receipts, flow-drive skill) exists —
  this is wiring them into an ordered, E2E-terminated gate.

**2. One task ledger, not four (concept 11)**
- **Pattern**: A single machine-readable ledger the scheduler picks from, the verifier judges against, and
  the handoff summarizes from — so scheduling/verification/handoff can't drift. Scope control is a data
  structure, not a convention.
- **Mechanism**: Elect one source of truth (candidate: the feature board in `src/features.ts`, or
  `done-proof.ts` as verification anchor); make the others *projections*, not parallel writers. Plane +
  plan-doc STATUS become rendered views/sync targets. `sync-plans`/`plan-sync.ts` already reconciles —
  invert it so there's nothing to reconcile.
- **Value for glance**: Drift is empirical and self-documented — the self-extension-factory overview
  records "recorded shipped in memory but STATUS never closed," and glance ships whole skills
  (`sync-plans`, `wip`) whose only job is to paper over four-ledger divergence. `src/features.ts` (46 KB)
  already aggregates plan concerns + agents + workflow progress + decisions — it's 80% of the single
  ledger already.
- **Where**: `src/features.ts` (canonical), `src/plan-sync.ts`, `sync-plans`/`plan-to-plane` skills,
  `src/done-proof.ts`, `src/concern-tickets.ts`.
- **Build vs Buy**: Borrow — consolidation of glance's own state model. Genuine work: four writers exist.

**3. Pre-dispatch harness scorecard (concept 21)**
- **Pattern**: Statically score a unit's harness across the five subsystems before spending a run. A
  malformed unit (no materialized spec, unscoped tools, no real gate) is a near-guaranteed waste — catch
  it cheaply.
- **Mechanism**: Given a unit's dispatch bundle, check: materialized spec (concern + primer non-empty)?
  scoped tool grant? worktree+baseline (env)? persisted state slot? *real* feedback gate (not a no-op
  verify)? Emit 0–5 score + red flags. Block/flag red units in `src/dispatch.ts` before spawn; surface in
  the webapp attention lane.
- **Value for glance**: "Context-poor units" is a named glance failure mode
  (`glance-vs-direct-diagnosis`). `src/agent-profiles.ts` already assembles the per-unit capability bundle
  — the scorecard is the missing *audit* over exactly that bundle, and it's cheap (static, no run).
  Converts "we dispatched a doomed unit" into "we flagged it at admission."
- **Where**: new check over `src/agent-profiles.ts` + `src/dispatch.ts` (admission), rendered in the
  webapp Intervene/attention view.
- **Build vs Buy**: Borrow. Small, static, fits an existing seam.

**4. Continuous-cleanup / golden-rule background fleet (concepts 18+19)**
- **Pattern**: Batch human cleanup of AI slop doesn't scale; encode taste once as mechanical,
  auto-checkable golden rules + run a low-priority background refactor-PR fleet against violations. The
  repo is both spec and drift source — agents copy whatever patterns already exist.
- **Mechanism**: A ruleset of mechanically-checkable rules (glance already has this shape:
  `tests/effect-ratchet.test.ts` fails on new legacy occurrences; envInt-not-`Number(env)`). Point a
  background loop at open violations, dispatching low-priority cleanup units through the existing fleet.
- **Value for glance**: glance is the ideal substrate — it already *is* a background-unit fleet with WIP
  caps and a proven land path, and already has a ratchet pattern (`scripts/effect-migration.ts`). Without
  it, concept 18 bites glance specifically: dispatched agents replicate suboptimal patterns already in
  `src/`.
- **Where**: reuse `src/dispatch.ts` + `src/scheduler.ts`; `plans/self-extension-factory/03-factory-loop.md`
  is the natural home; codify rules alongside `scripts/effect-migration.ts` + the ratchet test.
- **Build vs Buy**: Borrow. All fleet machinery exists; net-new = the rule catalog + a background arm.

**Folded in / N/A**: proximity + instruction routing (3/4) — the global fabric primer covers most of the
payoff; a per-`TOUCHES`-area short brief is a minor sharpening. WIP=1 (9) explicitly doesn't apply —
glance's value is worktree-isolated parallelism; per-unit attention is already 1.

---

## Handoff to /plan

- **Goal**: the ranked gaps above (gap #1 is the clear lead).
- **Application points (verified)**: `src/gate-runner.ts`, `src/done-proof.ts`, `src/features.ts`,
  `src/convergence-oracle.ts`, `src/fabric-search.ts`, `src/agent-profiles.ts`, `src/dispatch.ts`,
  `src/land-mode.ts`, `src/convergence-run.ts`, `AGENTS.md`, `plans/self-extension-factory/`.
- **Build vs Buy**: borrow patterns throughout — the source is MIT curriculum content, not a dependency.
- **Reusable glance machinery**: `verify` skill + `agent-browser` (terminal E2E stage), hermetic gate
  sandbox (`gate-env.ts`), proof receipts (`done-proof.ts`), effect-ratchet (golden-rule template).
