# Research Brief — Devin "Fusion" (Cognition)

**Source:** https://cognition.com/blog/devin-fusion
**Date:** 2026-07-06
**Target project:** omp-squad (autonomous agent-fleet factory)
**Pipeline:** SCOUT → COMPARATOR (sonnet) → STRATEGIST (opus; fable hit usage limit) → PERSIST

---

## 1. Scout brief — what Fusion is

A **multi-model agent harness**. Within one session, a frontier "**main agent**" (Opus 4.8 / GPT-5.5) and a cheaper "**sidekick**" model (Fable 5, GLM-5.2) run **in parallel**, each keeping **its own cached context**. Tasks route dynamically mid-session. Result: frontier-level code quality at **~35% lower cost** (**41%** with Fable 5 as sidekick). **88%** of Cognition's internal merged PRs were "driven entirely by the automated Fusion router."

### Key mechanisms
- **Parallel, not sequential routing.** Both agents run concurrently, each holding its own live cached context. The core trick: avoid paying to re-share context when switching models.
- **Division of decision rights.** The main (frontier) agent reserves *"the plan, the interpretation of ambiguity, the final review."* Default posture: *"delegate and monitor."* It *"reads only essentials"* to preserve its judgment budget. The sidekick does delegated mechanical work with its own toolset+context.
- **Dynamic mid-session switching.** *"Lightweight classifiers during task execution signal when we need to switch to the main agent or use a different model entirely."* Initial prompts lack enough info for static routing; complexity emerges as follow-ups arrive.
- **Switch-at-compaction.** Model switches are timed to context compaction — *"which would trigger a cache miss anyway"* — so switching is effectively *"free."* Exploits the ~**5-minute** cache expiry.
- **Benchmark philosophy.** They built "**FrontierCode**," measuring code **correctness AND quality/mergeability**, because existing routers *"over-fit to benchmarks and fail to write code you'd actually merge"* — *"real frontier intelligence rather than 'benchmark-score' intelligence."*
- **Vs prior art.** Their "**Smart Friend**" and Anthropic's "**Advisor**" both had one model *query* another for advice, but context wasn't cached across calls → *"you pay a very expensive price."* Fusion's persistent parallel cached contexts eliminate that.

---

## 2. Comparator — transferable concepts (idea vs implementation)

| # | Concept | How Cognition implemented it | Transferable? | Why / why not |
|---|---|---|---|---|
| 1 | Parallel dual-agent (concurrent, not sequential handoff) | Main + sidekick run concurrently, each with own live context | Yes | Structural choice any multi-model harness can make |
| 2 | Division of decision rights by ROLE not difficulty | Main reserves plan/ambiguity/final-review; "delegate and monitor" | Yes | Governance pattern: who owns judgment vs mechanics |
| 3 | Judgment-budget preservation via selective reading | Overseer reads only "essentials", not full transcript | Yes | Context-economy principle — overseer degrades if flooded |
| 4 | Mid-session dynamic re-routing via lightweight classifiers | Cheap classifier signals escalate-to-frontier when complexity emerges | Yes, w/ caveats | Insight is portable; the classifier itself is impl work |
| 5 | Switch-at-compaction | Swap model during compaction (cache miss coming anyway) | Conditionally | Rides a specific cache TTL / pricing regime |
| 6 | Custom benchmark resisting overfit | "FrontierCode" scores correctness + mergeability | Yes | Don't evaluate the router against a proxy that diverges from "human merges the PR" |
| 7 | Reject query-based advisor patterns | Contrasts Smart Friend / Advisor: uncached re-share cost | Yes | Checklist: verify you're not re-paying full context per cross-model call |
| 8 | Cost/quality as a per-SUB-TASK routing problem | Re-optimize cost/quality across the session, not one tier | Yes | Unit of optimization is the sub-task, not the session |
| 9 | Attribution as proof point | "88% of merged PRs by the router" — measured vs real merges | Yes | Measure the automated decider vs downstream acceptance, not self-confidence |
| 10 | Sidekick has a PURPOSE-BUILT toolset | Cheap model gets role-appropriate tools, not a pared-down copy | Partially | What's "mechanical enough to delegate" is domain-specific |
| 11 | Escalation is bidirectional/lateral | Classifier can escalate, de-escalate, OR route to a third model | Yes | Router action space should include lateral moves |
| 12 | Accept paying for two live contexts | 35–41% savings is net of two concurrent contexts | Partially | Only nets positive above a delegation-ratio threshold |

### Design tensions Cognition accepted
- Two live contexts = a **constant** fixed overhead traded to kill a **spiky** re-share cost. Only pays off at a high delegation ratio.
- Reserving **final review** to one agent = a single arbitration point and a scaling ceiling (main agent's judgment budget becomes the bottleneck the system was built to avoid).
- **Switch-at-compaction** is opportunistic, not principled — coupled to a specific cache-TTL/pricing regime; could evaporate under a different one.
- A **custom benchmark** is an admission no existing yardstick was trustworthy — real construction+maintenance cost paid to avoid a worse cost (a metric-gaming router).
- **"Delegate and monitor"** accepts **under-escalation risk** (sidekick silently ships something wrong) in exchange for not re-checking everything.

---

## 3. Strategist — ranked concepts mapped onto omp-squad

**The key strategic fact:** omp-squad *already* has (a) per-task-class model routing (`src/workflow/stylesheet.ts`), (b) a live mid-run `setModel` switch point (`src/workflow/executor.ts:177-188`), (c) an independent judge on a different model (`src/validator.ts`, `OMP_SQUAD_VALIDATOR_MODEL ?? "opus"`), (d) full per-harness/per-model cost attribution (`src/omp-graph/`), and (e) run confidence (`src/confidence.ts`). Fusion's flagship mechanism (intra-session dual-context parallelism) is the **weakest** fit, because omp-squad already parallelizes **across** worktrees. The real unlocks are the two things it *lacks*: an outcome feedback loop and mid-run difficulty escalation.

### #1 — Router evaluated against real land outcomes (proof-point attribution) ⭐ THE unlock
- **Pattern:** Close the loop on an automated decider by joining each routing decision to the downstream real-acceptance signal (PR merged/landed), not the decider's own confidence.
- **Mechanism:** Stamp each unit at dispatch with its routing decision (task-class/selector → model+effort); carry the stamp through the run; at land time record outcome (landed / vetoed / verify-failed / abandoned / rework-count) + attributed cost. Aggregate into a `task-class × model` matrix of `{merge-rate, median-cost, median-confidence, rework-rate}`. **This matrix IS the maintainer's wanted "task-class × model rubric scoreboard,"** and it regenerates `stylesheet.ts` from evidence instead of hand-tuning.
- **Where:** emit decision from `executor.ts:177-188` (`resolveStyle`) + `smart-spawn.ts` (`SpawnPlan`); join land outcome (`dispatch.ts`, `squad-manager.ts` land path) + confidence (`confidence.ts`, `convergence-run.ts:117`); aggregate by extending `AttributionDoc` in `src/omp-graph/attribution.ts`; surface via `webapp/src/lib/insights.ts`.
- **Build vs Buy:** **Borrow.** Every seam already exists; this is wiring. No dependency knows omp-squad's land semantics.

### #2 — Mid-run difficulty-triggered escalation (cheap→frontier, bidirectional)
- **Pattern:** You can't route correctly from the initial prompt; complexity reveals itself mid-task. Make routing a running decision — a lightweight signal re-routes the model when emerging difficulty crosses a threshold. Bidirectional/lateral, not a one-time up-front pick.
- **Mechanism:** The switch point already exists (`executor.ts` calls `setModel` when resolved style changes). Add a dynamic signal source — repeated verify failures, `convergence-run` confidence below `confidenceFloor()`, a stalled/looping unit, N rework cycles — feeding `resolveStyle` as a dynamic override (a `.struggling` pseudo-class). A unit on haiku/sonnet gets promoted to opus for the next node; a unit sailing through cheap work stays cheap.
- **Value:** Highest-leverage *behavioral* unlock. The factory's failure mode is a cheap model thrashing a hard unit (memory records verify-loops thrashing hard units). Static routing forces over-provision (expensive) or under-provision (untrustworthy). This gets frontier quality only where the unit proves it needs it — Fusion's 35–41% story expressed in omp-squad's per-unit worktree model.
- **Where:** inject dynamic override before `resolveStyle` in `executor.ts:177-188`; signals from `convergence-run.ts:117`, `validator.ts`, `confidence.ts`; author a difficulty pseudo-selector in `stylesheet.ts`; `setModel` seam (`rpc-agent.ts`/`agent-driver.ts:56`) already carries it.
- **Build vs Buy:** **Borrow.** Rule-based to start (below-floor confidence OR ≥2 verify fails ⇒ escalate one tier); #1's data tunes the thresholds. No ML router needed.

### #3 — Mergeability benchmark that resists overfit
- **Pattern:** Evaluate the router against a held-out set of real tasks scored on correctness AND mergeability, because a router optimized against a proxy overfits the proxy.
- **Mechanism:** Curate a frozen set of past omp-squad units with known outcomes. Replay routing/model changes offline; score on mergeability + rework, not tests-green or self-confidence. Gate new `stylesheet.ts` / escalation thresholds behind it.
- **Value:** The guardrail that makes #1/#2 *safe*. omp-squad's own `scoreConfidence` folds validator pass/fail — a proxy; a merge-scored benchmark is the anti-overfit backstop so a data-driven router doesn't learn to game confidence.
- **Where:** frozen set from `receipts.ts` history + land outcomes; scored by the #1 outcome join; guards `stylesheet.ts` changes.
- **Build vs Buy:** **Borrow**, kept small/outcome-frozen (honor the maintenance-cost tension).

### #4 — Cost/quality as a per-sub-task routing problem
- **Largely already done** — `stylesheet.ts`'s entire premise + per-node `resolveStyle`. Missing piece is making the per-task choice *learned* (#1) and *dynamic* (#2). **Borrow / already built.**

### #5 — Division of decision rights by role, not difficulty
- **Half done.** `validator.ts:35-37` already reserves *final review* to a pricier model while the executor runs sonnet. Not modeled: reserving *plan + ambiguity resolution* to frontier. Unlock (modest): a `.plan`/`.ambiguous` selector routing those nodes to frontier even in a cheap-default unit. omp-squad's per-unit fan-out means the "single reviewer bottleneck" tension doesn't centralize. **Borrow**, one-selector change.

### #6 — Parallel dual-model execution within one unit (two live contexts)
- **Lowest fit of the flagships — DEFER.** Fusion needs intra-session parallelism because it runs one session at a time; omp-squad gets parallelism *across* worktrees (`maxActive`/`maxWip`). Second live context inside one unit = high cost, low marginal value; the ACP/rpc driver seam isn't built to host two concurrent models in one worktree. Escalation (#2) captures most of the benefit far cheaper. **Borrow the idea, defer the build.** Revisit only if #1's data surfaces a unit class where monitored-cheap + frontier-overseer beats single-model escalation.

### #7 — Switch-at-compaction
- **Regime-coupled, medium-low.** `executor.ts` already switches at node boundaries (a natural seam). Aligning to compaction only pays if the ACP/codex harness exposes compaction events and prices cache like the source's regime; `receipts.ts` tracks `cacheRead/cacheWrite` so the signal partly exists. Treat as an opportunistic optimization on top of #2 (defer a non-urgent escalation to the next node boundary). **Borrow the heuristic**, low priority.

### #8 — Judgment-budget preservation via selective reading
- **Mostly already done.** `validator.ts` `scoreAgainstCriteria(criteria, diff)` is exactly a selective-input judge. Refinement: keep this discipline in any future escalation/overseer path (#2/#5) rather than re-sharing full context. **Borrow / already built.**

### #9 — Sidekick has a purpose-built toolset
- **Conditional/low**, gated on #6. Latent hook: `types.ts:968` `model?: string|false` (`false` = deterministic no-LLM worker) already differentiates worker kinds. If a sidekick tier lands, give it a role-shaped toolset. **Borrow, gated on #6.**

### #10 — Reject query-based advisor patterns
- **A design-review caution, not a build.** No advisor pattern today, but `squad_message` and the validator feedback path could grow into one. Rule: if you add a cross-model "get advice" call, verify via `receipts.ts` you're not re-priming full context each call — prefer role-division (#5)/escalation (#2). **Borrow as a principle**, no code.

### If you do only ONE thing
Build the **router-outcome feedback loop (#1)**: stamp each unit with its routing decision at dispatch, join it to the real land/merge outcome, and aggregate a `task-class × model` matrix of `{merge-rate, cost, confidence, rework}` in `omp-graph`. That artifact IS the maintainer's wanted scoreboard, it turns the hand-authored model-policy table and `stylesheet.ts` from opinion into a measured control loop, and it's the prerequisite that makes dynamic escalation (#2) safe to trust.

### Whole-set build-vs-buy
**Borrow every pattern.** omp-squad already owns every seam (stylesheet router, live `setModel` switch, opus validator, cost attribution, confidence) — there is no dependency to adopt, only wiring to add. The only flagship worth *not* building is Fusion's intra-session dual-context parallelism (#6): omp-squad already parallelizes across worktrees, so escalation captures the cost/quality win without paying for two live contexts.

---

## 4. Handoff to /plan (if actionable)
- **Goal:** the router-outcome feedback loop (#1) → dynamic difficulty escalation (#2) → mergeability benchmark guardrail (#3), in that order. #1 is the keystone and the open "task-class × model rubric scoreboard" want.
- **Accelerated EXPLORE:** application points already verified above — `executor.ts:177-188`, `stylesheet.ts`, `dispatch.ts`/`squad-manager.ts` land path, `omp-graph/attribution.ts` + `receipts.ts`, `confidence.ts`/`convergence-run.ts:117`, `validator.ts`, `webapp/src/lib/insights.ts`.
- **Build vs buy:** borrow every pattern; no dependency. Defer #6 (dual-context parallelism).
