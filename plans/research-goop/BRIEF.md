# Research Brief: GOOP (Gentic Object-Oriented Programming)

**Date:** 2026-07-07
**Target project:** omp-squad (glance) — TS/Bun daemon-driven autonomous multi-agent fleet
**Source:** "GOOP: A Meta-Programming Framework for Self-Bootstrapping Multi-Agent Systems" — Anser & sovthpaw, Nous Research Hermes fleet, v1.0, July 4 2026. Vision spec, **no implemented system**.
**Verdict in one line:** GOOP is an independent re-derivation of what glance has largely already built and shipped; glance is *ahead* on the hard parts. The useful residue is one mechanism glance genuinely lacks — **verification-gated self-authoring of new capabilities** — plus two engines to build it with (GEPA candidate selection, DSPy interface/strategy/optimizer split).

---

## 1. What GOOP is

A framework proposing that multi-agent LLM fleets are *already object-oriented* and should be organized around three typed primitives — **Skills** (methods), **Agents** (classes), **Loops** (main/workflow) — plus a shared memory substrate (**Continuity Stream** raw log + **Wiki** comprehension layer), a tool-free conversational **front-door** agent, and three **factory meta-agents** (Skrypt/Klerik/Kadens) that *author new instances of each primitive from observed demand* using a single unified methodology derived from **DSPy/GEPA**. It makes three honestly-graded claims: weak (organizing this way is more coherent — near-certain), medium (meta-agents can usefully self-extend with human approval — unverified, their focus), strong (robust autonomous self-extension — explicitly not claimed). Nothing is built end-to-end; only Klerik's 4-stage prompt pipeline exists.

## 2. External dependencies — all verified real (scout A)

| Dep | Status | Load-bearing mechanism to reuse |
|---|---|---|
| **GEPA** (arXiv:2507.19457, ICLR 2026 Oral — verified via OpenReview) | Real, claims check out (+10pp avg over MIPROv2, +6pp over GRPO, 35× fewer rollouts) | **Pareto-frontier mutation selection**: generate N candidates; metric returns `(score, natural-language feedback)` not a scalar; keep the set best on ≥1 instance; sample next mutation ∝ frontier membership. Deliberately avoids collapse onto one "best" candidate. |
| **DSPy** (arXiv:2310.03714 — GOOP's "DSLy" is a typo) | Real | **Signature / Module / Optimizer separation**: interface (typed I/O) vs strategy (how the LLM is asked) vs tuning (optimizer sets instructions+demos from data). Lets an optimizer slot in without touching pipeline code. |
| **Voyager** (arXiv:2305.16291) | Real, ablations verified | **Verification-gated skill-write path**: a candidate skill enters the reusable library ONLY after a critic confirms it against unambiguous ground truth. Removing this gate = **−73% discovered items**. Ungated skill accumulation rots the library. |
| **Hermes Agent** (NousResearch) | Real, MIT, active | Cross-profile shared kanban work-queue. *(glance already has this via Plane — no action.)* |

Skepticism note: Hermes's reported 210k stars is implausible for a 2025-07 repo and likely a bad API read / parody ecosystem; irrelevant since we borrow patterns, not the dependency.

## 3. GOOP → glance capability map (scout B, paths verified)

| GOOP building block | glance state | Where |
|---|---|---|
| Typed primitives (Skill/Agent/Loop) | **Surpassed** — richer Capability manifest, 7 binding types | `src/capabilities/index.ts`, `catalog.ts`; profiles `src/agent-profiles.ts`; per-node model routing `src/workflow/stylesheet.ts`; loops `AutomationLoop` (8 kinds) `src/scheduler.ts`/`src/automation-log.ts` |
| Continuity Stream (one append-only turn log) | **Partial / fragmented** — re-joined only as a derived read-view | `transcripts` in `src/dal/store.ts`, `receipts/*.jsonl` (`src/receipts.ts`), `automation.jsonl`, `transitions.jsonl` → `src/fabric.ts` + BM25 `src/fabric-search.ts`. Open plan: `plans/factory-control-plane/05-durable-event-journal.md` |
| Wiki / Record Keeper (comprehend → suggest → trigger) | **Comprehension mature; trigger half thin** | `webapp/src/lib/insights.ts` (38KB), `src/fabric.ts`, FLEET PULSE `webapp/src/omp-graph/`. Triggering: only agent-raised `squad_report` rows + `AttentionItem`; loops `src/opportunity.ts`, `src/resident-planner.ts` (OFF) |
| **Factory meta-agents (author capabilities from demand)** | **MISSING** — provisioning rails exist, generative front-end does not | Install/validate/approve lifecycle `src/capabilities/index.ts` + `/api/capability-*` in `src/server.ts`; worker commissioning `src/workflow/commission-executor.ts`; scalar-only self-tuning `src/threshold-tuner.ts`/`src/model-outcomes.ts`/`src/reflection.ts` |
| Front-door + injection | **Surpassed** — plural surfaces beat one lane | Intervene View `src/intervene.ts`, `squad_report`/`squad_message` `src/squad-manager.ts`, web-push `src/push.ts`, TUI `src/tui.ts` |
| Least-privilege access matrix + no-self-edit | **Surpassed** — runtime-enforced, not policy | Role tiers `src/authz.ts`, scope `src/agent-scope.ts`, tool allowlist, runtime guard `src/agent-guard.ts` (blocks writes outside own worktree even in yolo). Absent: per-profile MCP scoping (`.omp/mcp.json`); fine-grained ownership authz (deferred, `authz.ts` "ponytail") |

**Genuine gaps:** (A) meta-agents that author capabilities from observed demand; (B) a comprehension→suggestions→trigger queue; (C) a single canonical event journal (already planned).

## 4. Ranked transferable concepts (strategist)

### #1 — Self-Extension Factory: verification-gated capability authoring  ·  Impact HIGH · Confidence MED-HIGH
**Pattern:** A meta-process that detects unmet demand from the fleet's own activity, drafts a candidate capability (skill/workflow/profile) to meet it, *proves the candidate works by executing it in isolation against a ground-truth signal*, and only then admits it to the catalog — human-approved at the final gate.
**Mechanism:** (1) Collect demand from the evidence substrate (repeated manual work, agent confusion, failure clusters). (2) Generate N candidate manifests. (3) **Critic-gate**: instantiate each candidate in a throwaway git worktree and actually run it against the originating task; score by the *real* verify/land outcome, not by an LLM's opinion. (4) Keep the frontier winner; route it through the existing `imported→validated→approved→enabled` lifecycle for human sign-off.
**Value for glance:** glance already owns every surrounding rail — evidence substrate (`fabric.ts`/`receipts.ts`/`insights.ts`), the install/validate/approve lifecycle, worker commissioning, and — critically — **worktree-isolated execution with a real verify/land gate**. That last piece is glance's equivalent of Voyager's diamond-mining ground truth: a self-authored skill can be *tested by running it* before it is trusted, which is exactly the gate Voyager's ablation proves is load-bearing (−73% without it). The marginal build is small: a GENERATE front-end + a critic-GATE, bolted onto rails that already exist. This is the natural next rung on glance's meta-harness bet.
**Where it applies:** `src/capabilities/index.ts` (add authoring source), new generator alongside `src/smart-spawn.ts`/`src/plan-writer.ts`, critic harness reusing the worktree+verify path, trigger from `src/opportunity.ts`.
**Build vs Buy:** Borrow the pattern (Voyager gate + GOOP factory framing). No dependency — Python stacks, glance surpasses them.

### #2 — Pareto-frontier candidate engine (the generate+evaluate core for #1)  ·  Impact HIGH (as enabler) · Confidence MED
**Pattern:** When optimizing any LLM-authored artifact, don't iterate a single best candidate — hold a *frontier* of candidates each best on ≥1 evaluation instance, and mutate proportional to frontier membership; feed the mutator natural-language feedback from execution traces, not a scalar.
**Mechanism:** GEPA's loop, minus its Python packaging: minibatch rollout → `(score, feedback_text)` metric → reflection LLM does credit assignment → new candidate → Pareto-frontier admission + proportional resampling.
**Value for glance:** This is the engine that makes #1 robust instead of naive. Also directly upgrades glance's *existing* scalar-only learning loop (`threshold-tuner.ts`, `reflection.ts`, `model-outcomes.ts`) from "tune a number" to "evolve an artifact with textual credit assignment." glance's receipts already carry rich trace/feedback text to feed the mutator.
**Where it applies:** new `src/optimize/frontier.ts` engine; consumers `src/reflection.ts`, `src/threshold-tuner.ts`, and #1's generate stage.
**Build vs Buy:** Borrow the algorithm (reimplement in TS; ~100 lines of selection logic). DSPy's `dspy.GEPA` is Python-only and not adoptable here.

### #3 — Comprehension → suggestions → trigger queue  ·  Impact MED · Confidence MED (folds into #1)
**Pattern:** The comprehension layer should not just *display* insight — it should emit a durable, actionable next-step queue that autonomous loops consume as their demand signal.
**Mechanism:** Extend `insights.ts`/`fabric.ts` to write a `suggestions` stream (typed: new-skill / fix-agent / new-loop / raise-cap) with provenance; `opportunity`/`resident-planner` (and #1's factory) subscribe.
**Value for glance:** Closes gap B and supplies #1's Stage-1 demand automatically. glance already computes the raw signals (churn hotspots, flapping agents, collisions) — this promotes them from a dashboard read-view to a work-triggering queue.
**Where it applies:** `webapp/src/lib/insights.ts`, `src/fabric.ts`, `src/opportunity.ts`.
**Build vs Buy:** Borrow the pattern.

### #4 — Evidence-only creation discipline  ·  Impact MED · Cost LOW
**Pattern:** No capability is authored without documented demand traced to real fleet activity — no speculative "just in case" skills/agents/loops.
**Mechanism:** Every factory-authored manifest carries a provenance pointer to the demand evidence; the approve step rejects manifests with no backing evidence.
**Value for glance:** Cheap guardrail that keeps a self-extension factory from bloating the catalog. Fits glance's existing provenance-carrying `FabricDecisionFact`.
**Where it applies:** `src/capabilities/index.ts` validation, `FabricDecisionFact` in `src/fabric.ts`.
**Build vs Buy:** Borrow (policy, near-zero code).

### #5 — DSPy signature/module/optimizer separation for capability authoring  ·  Impact MED · Urgency LOW
**Pattern:** Represent an authored capability as a typed contract (signature) + a strategy (how the LLM is prompted) + an optimizer target — so the frontier engine (#2) can tune it without rewriting it.
**Value for glance:** `model_stylesheet.ts` is already close to this for model routing; generalizing the split makes #1's candidates optimizable by #2 uniformly.
**Where it applies:** `src/workflow/stylesheet.ts`, capability schema in `src/capabilities/`.
**Build vs Buy:** Borrow the abstraction. Architectural seasoning, not urgent.

### #6 — Durable event journal (Continuity Stream)  ·  Impact MED · Already planned
**Pattern:** One canonical append-only journal of every turn/event, replayable, as the authoritative substrate the derived views rebuild from.
**Value for glance:** Would strengthen the "collect evidence" stage of #1. But `fabric.ts` already re-joins the fragmented stores well enough to *bootstrap* the factory — this is a quality improver, not a blocker. **Already scoped**: `plans/factory-control-plane/05-durable-event-journal.md`. Research raises its priority as the factory's evidence backbone.
**Build vs Buy:** Build (already planned).

### Validates existing design — NO action
- **Single-lane injection front-door**: glance's plural surfaces (Intervene View + push + TUI) are a better answer than GOOP's one woven lane. GOOP even lists this as its own risk (injection flooding).
- **No-self-edit rule**: glance's `agent-guard.ts` enforces this at runtime (write-scope to own worktree), stronger than GOOP's policy.
- **OOP typed-primitive framing**: glance's Capability manifest (7 binding types) already surpasses GOOP's flat 3.
- **Cross-profile kanban**: glance has it via Plane.

## 5. Verdict

**Worth a `/plan`, tightly scoped.** The coherent plan is a **Self-Extension Factory**: #1 as the spine, #2 as its optimization engine, #3 as its demand trigger, #4 as its guardrail. #5 is adjacent refactoring; #6 is known/planned and becomes a dependency to prioritize. Everything else in GOOP is something glance already ships or surpasses — the honest finding is that glance is roughly a *phase ahead* of GOOP's vision, and the single highest-ROI move is to build the one rung GOOP names that glance hasn't climbed: turning glance's provisioning rails + worktree-isolated verify gate + evidence substrate into an actual capability-authoring loop, with Voyager's critic gate as the thing that keeps it from rotting.
