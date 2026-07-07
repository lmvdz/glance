# Research BRIEF — "Recursive Research/Council/Code Orchestration (v2)"

**Target artifact:** a design document (a set of original system prompts) describing a
multi-agent architecture: one **persistent Orchestrator** holding all authority + context
continuity, plus three disposable roles — a **Research Sub-Agent pool** (8 lens personas), a
**Coding Sub-Agent** (serial, disposable), and a **Council pool** (8 review personas). The
Orchestrator selects 4–8 personas per wave/convening based on the task; research runs a
WIDE→MEDIUM→NARROW funnel; the Council is advisory-only and the Orchestrator disposes of each
finding via ACCEPT / REJECT / VERIFY.

**Target project:** omp-squad (aka *glance*) — a persistent daemon fleet that dispatches
worktree-isolated, harness-agnostic units and lands them via a validated merge gate.

**Method:** the artifact is self-contained (no external repo to scout), so SCOUT = reading the
document; the analytical work was grounding its concepts against omp-squad's *live* code via
three parallel read-only scouts (review architecture, orchestration topology, capability
selection). Every mapping below cites verified files.

---

## Headline verdict

This document is not a tool to adopt — it's a **design spec omp-squad has largely converged on
independently**. Cross-lineage adversarial review, agent-profile capability bundles, per-step
model routing, pre-execution policy/cost/blast-radius gates, and "don't re-derive delegated
work" are all already shipped or planned. The convergence is itself the strongest signal: an
independent author reasoning from first principles landed on omp-squad's architecture.

Two things fall out of the comparison that are *not* platitudes:

1. **One deliberate divergence to hold the line on** — the document's orchestrator-centric
   "single agent holds all continuity, everything else disposable" model is the exact inverse
   of omp-squad's core bet (unit context lives in detached inner processes; the daemon is a
   state machine holding only a replay projection). omp-squad already red-teamed and rejected
   the document's model. **Do not adopt it.**

2. **One genuine gap worth building** — the document diversifies review by *perspective*
   (8 distinct lenses, task-selected). omp-squad diversifies review by *vendor* (cross-lineage)
   but runs **one monolithic judge** over all criteria at once. Perspective-diversity is an
   orthogonal, complementary independence axis omp-squad does not have.

---

## What omp-squad already has (independent convergence)

| Document concept | omp-squad equivalent | Evidence | Status |
|---|---|---|---|
| Coding sub-agent: scoped, serial-by-default, disposable, "assume you're not alone" | Worktree-isolated units, dependency-gated dispatch (one unit per Plane issue, `maxActive` cap) | `src/dispatch.ts:154` (`tick`), `:239-247` (blockedBy gating) | SHIPPED |
| Council reviews code *before* acceptance; orchestrator reads the work first | Independent validator gate: computes the would-be-merged diff itself, feeds diff+criteria+proof to the judge | `src/validator.ts:293-317` (`computeLandDiff`), `:325` (`validatorGate`) | SHIPPED |
| Review from a genuinely different angle than the author | Cross-lineage review — reviewer runs a different vendor lineage; same-lineage grades render as a *weaker* trust signal | `src/model-lineage.ts`, `src/validator.ts:65-74`, `src/confidence.ts:39` | SHIPPED (disjoint codex judge built, opt-in/off) |
| Select which capability/persona bundle runs a task | Agent Profiles: `{harness, bin, model, thinking, mcp, capabilities, memory}` chosen per unit | `src/agent-profiles.ts`, `src/squad-manager.ts:3076-3101`, `--profile` (`src/index.ts:443`) | SHIPPED (PR #92) |
| Cheap-by-default, frontier-on-hard | `model_stylesheet` per-step routing + intake thinking-level | `src/workflow/stylesheet.ts`, `src/workflow/executor.ts:180-189` | SHIPPED |
| Pre-commit gating / risk awareness | Policy-as-data + land blast-radius gate + shadow cost projection | `src/policy.ts`, `src/land-risk.ts`, `src/cost-gate.ts` | SHIPPED |
| DELEGATE AND WAIT; don't re-derive delegated work; sit idle | Emergent from idempotency ledgers + single-thread context-carry (never re-spawns a closed concern; orchestrator delegates coding, only verifies/lands) | `src/dispatch.ts:120-127` (`alreadyDone`), `src/orchestrator.ts:121-131`, research-plan-implement.fabro header | SHIPPED (emergent, not a named primitive) |
| Parallel angles on one target, pick the winner | `fan-out` workflow: one steerable worktree agent per branch (Simplicity/Perf/Minimal-deps), review node picks winner | `workflows/fan-out/workflow.fabro` | SHIPPED |

## What omp-squad deliberately rejected (do not adopt)

| Document concept | Why it does not port |
|---|---|
| **Single persistent Orchestrator holds ALL continuity; every other agent disposable** | omp-squad's core bet is the inverse: each unit's live context lives in a **detached inner omp process** (`src/agent-host.ts:1-23`, survives daemon restart via `setsid`+unref); the daemon is a **state machine** holding a roster + ledgers + a replayed projection, *not* a reasoning agent that holds the goal. The daemon's *only* channel into a live unit is composing a note into its next turn (`continueAgent`, `src/orchestrator.ts:78-83`). Two red teams already ruled the orchestrator-holds-context model "incoherent" for exactly this reason (per the agent-profiles design). The goal is externalized to Plane issues; decomposition is distributed (resident planner loop *or* a `/plan` unit), never a central brain. |
| **WIDE→MEDIUM→NARROW research funnel inside the system** | No such multi-wave funnel exists in the daemon, and it doesn't belong there — research is a *main-session skill* (`/research` already ≈ SCOUT→DISSECT→ABSTRACT; `/deep-research` does adversarial claim verification). Marginal value; at most it sharpens those skill prompts, not omp-squad code. |

---

## Comparator table — concept vs transferable pattern

| Concept | How the document implements it | Transferable to omp-squad? | Why / why not |
|---|---|---|---|
| Persona **pool** of distinct review lenses (code-quality, security, architecture, red-team, performance, testing, maintainability, general) | 8 named system prompts; orchestrator convenes 4–8 per review | **YES — genuine gap** | omp-squad review is *one* judge scoring all criteria in a single call (`src/validator.ts:198`). No lens split, no panel. This is perspective-diversity — orthogonal to the vendor-diversity already shipped. |
| **Task-conditional** persona selection ("pick 4–8 of 8; a config change doesn't need the perf reviewer") | Orchestrator judgment per convening | **YES** | omp-squad has the classifier substrate already — `src/intake.ts` (`routeIntake` heuristics: HIGH_RISK/FANOUT/HARD/TDD) + `src/land-risk.ts` (blast radius). Nothing yet selects *reviewers* by what changed. |
| **Council is advisory-only; Orchestrator disposes ACCEPT/REJECT/VERIFY** — VERIFY = spawn a narrow re-check rather than trust the reviewer | Explicit three-way disposition; "hold the line when the Council is confidently wrong" | **PARTIAL** | omp-squad's primary validator is (correctly) **authoritative** — a veto blocks the merge (`src/squad-manager.ts:2765`). Keep that. But *new* lens/disjoint judges should be advisory + feed confidence, matching omp-squad's own stated instinct ("stays advisory until the harness earns `verified:true`"). The **VERIFY branch (targeted re-check on objection) is missing** — today it's binary veto-or-pass, or a veto-reprompt to the *same* unit (`OMP_SQUAD_VETO_REPROMPT`, off). |
| Separation of monitor / judge / intervenor | Three role sections, no overlap | Already held | omp-squad structurally enforces MONITOR≠JUDGE≠INTERVENOR (`src/drift-lens.ts:1-15`). Convergent, nothing to borrow. |
| Never pass raw sub-agent output to the Council unreviewed | Orchestrator reads first | Already held | `validatorGate` extracts the diff itself; the judge is prompted to distrust author claims (`src/validator.ts:76-81`). |

---

## Strategist — ranked transferable concepts

### 1. Lens-diversified review panel  *(highest value; medium urgency)*

**Pattern:** review a change through several *distinct, focused perspectives* rather than one
monolithic pass — each lens a separately-scoped judge with its own system prompt, aggregated by
the gate.

**Mechanism:** extend the validator so that, in addition to (or composing with) the single
criteria judge, the land gate can fan the diff across a small set of lens-scoped judges
(security, performance, architecture, red-team/refute, testing). Each returns a scoped verdict;
the gate aggregates. This is a **second independence axis orthogonal to lineage**: cross-lineage
varies *who* judges (vendor), lenses vary *what they look for* (perspective). A monolithic judge
holding 8 concerns in one prompt exhibits attention dilution and correlated blind spots — the
same reasoning behind omp-squad's own drift-lens monitor/judge separation.

**Value for omp-squad:** raises how much can land hands-off. Today a security regression and a
perf regression are graded by the same diluted pass; a focused security judge that only hunts
input-trust/authz issues catches more. The **red-team/refute lens is already half-designed** as
`plans/meta-autonomous-fleet/epic-3-independent-validator/07-adversarial-refute-before-land.md`
(worktree-only) — this generalizes it into a small pool.

**Where it applies:** `src/validator.ts` (fan-out + aggregation), `src/confidence.ts` (weight
advisory lens verdicts), `src/types.ts` (`ValidationRecord` gains per-lens sub-verdicts).

**Build vs Buy:** borrow the *pattern*. No dependency — it's a prompt/orchestration shape.

**Honest caveat:** cross-lineage review *just* shipped as the chosen independence axis, so this
is incremental, not urgent; and its cost (N judge calls) must be bounded by concept #2 or it's
gold-plating on a one-line diff. Rank it #1 on value, but gate the build on concept #2 landing.

### 2. Diff-surface-conditional lens selection  *(enabler for #1; highest tractability)*

**Pattern:** select *which* review lenses fire from what the diff actually touches — don't run
all of them on every change.

**Mechanism:** reuse the existing classifier substrate. `src/intake.ts` already buckets tasks
(HIGH_RISK/FANOUT/HARD/TDD via regex, LLM-swappable); `src/land-risk.ts` already computes blast
radius from `filesTouched`. Map diff signals → lens set: auth/input-handling paths → security
lens; hot-path/loop changes → performance lens; broad blast radius → architecture lens;
docs/config-only → skip both (fall back to the single criteria judge). This is the document's
"pick 4–8 of 8, and a config change doesn't need the perf reviewer" made concrete on
infrastructure omp-squad already ships.

**Value for omp-squad:** makes concept #1 *affordable* (you don't pay for 8 judges on a config
tweak) and is the natural extension of the current 4-bucket intake router — which today picks a
*process*, never a *reviewer set*.

**Where it applies:** `src/intake.ts` (or a sibling `review-lens-selector.ts`),
`src/land-risk.ts` (reuse), wired into the validator fan-out from #1.

**Build vs Buy:** borrow the pattern; pure reuse of existing omp-squad primitives.

### 3. ACCEPT / REJECT / VERIFY disposition for advisory reviewers  *(governance nuance)*

**Pattern:** a non-authoritative reviewer's finding gets *disposed*, not obeyed — accept it,
reject it, or **verify** it with a narrow, targeted re-check before acting. Never auto-defer to
a confident reviewer.

**Mechanism:** keep the primary criteria validator authoritative (its veto blocks the merge —
that is the trust floor, do not weaken it). For the *new* lens judges and the disjoint codex
judge, make the verdict **advisory**: it adjusts `confidence` and, on a strong objection, can
trigger a **VERIFY** branch — a single narrow re-check scoped to exactly that claim — rather
than a hard veto or a full veto-reprompt of the whole unit. This gives omp-squad's already-
stated instinct ("advisory until `verified:true`") an explicit control-flow shape, and adds the
one branch it lacks: *targeted re-verification of a single finding*.

**Value for omp-squad:** lets the fleet act on lens/disjoint-judge signal without either
ignoring it (waste) or letting an unproven judge fail-closed the whole land (fail-open landmine
the cross-lineage design already warned about).

**Where it applies:** `src/validator.ts` (disposition logic), `src/orchestrator.ts` (the
narrow-re-check dispatch, adjacent to the existing veto-reprompt path).

**Build vs Buy:** borrow the pattern.

### Marginal — noted, not recommended to build

- **DELEGATE-AND-WAIT as an explicit primitive** — already emergent from omp-squad's idempotency
  ledgers + single-thread context carry. The document's framing is a good *prompt-discipline
  note* for the in-harness `/squad` and orchestrator skills (this very research turn used it),
  but it is not net-new daemon code.
- **WIDE→MEDIUM→NARROW research funnel** — belongs to `/research` and `/deep-research` skills,
  not the daemon; those already embody a scout→dissect→abstract narrowing.

---

## Handoff

**Build-vs-buy overall:** borrow patterns, adopt nothing. The artifact is a design spec, not a
dependency.

**If chaining to `/plan`:** the goal is concepts **#1 + #2 as one plan** (the lens panel is only
sound if its cost is bounded by conditional selection), with **#3** as a small governance concern
folded in. EXPLORE can be abbreviated — application points are already verified:
`src/validator.ts`, `src/confidence.ts`, `src/intake.ts`, `src/land-risk.ts`, `src/types.ts`,
and the existing `07-adversarial-refute-before-land.md` design to generalize.

**If intel-only:** this BRIEF is the durable record; the honest takeaway is that the document
*validates* omp-squad's architecture and contributes exactly one missing axis — perspective
diversity in review.
