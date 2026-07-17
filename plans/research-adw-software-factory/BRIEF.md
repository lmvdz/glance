# Research Brief: AI Developer Workflows / the Software Factory model → glance

## Provenance

- **Date**: 2026-07-15
- **Input**: user-supplied distillation of the "AI Developer Workflows" (ADW) / software-factory framework — a 6-stage maturity progression plus building rules. Closely matches IndyDevDan's *Tactical Agentic Coding* framing (https://agenticengineer.com/tactical-agentic-coding); the broader staging echoes https://alexop.dev/posts/the-software-factory/ and https://www.freecodecamp.org/news/how-to-build-software-factory-with-claude-code/. This is a concept framework, not a tool — there is no repo or version to pin; the distillation itself is the primary source.
- **Target project**: glance (omp-squad) — autonomous agent-fleet orchestrator: daemon dispatches coding agents into isolated git worktrees, gates their work with real code, and lands it via a proven merge train. Ground truth verified against main @ `5b0a2d1` (2026-07-15) by a codegraph-backed sweep of `src/`.
- **Confidence**: ground-truth file anchors are code-verified. The framework's own claims (e.g. "specialized agents beat general agents, especially for hotfixes") are vendor/instructor assertions, not independently benchmarked here.

## The framework (scout brief)

Three actors create value — engineers, agents, code — and the job is placing each correctly: code is most reliable/cheapest/fastest, agents least reliable/most expensive, engineers belong at the two ends (planning and review). Stop thinking in loops; think in AI Developer Workflows inside a software factory.

Six-stage progression:

1. **Atomic unit** — engineer writes prompt → agent works → engineer reviews.
2. **Separate agents from code** — pull deterministic steps (lint, format, typecheck, tests) out of the agent into explicit nodes; on failure, feed the error back into the *same* agent session.
3. **Specialize agents** — scout / plan / build / test, later hotfix / chore / feature experts. A narrowly templated expert beats a general-purpose agent.
4. **Isolation** — worktrees first, then full sandboxes (each agent its own computer) for true parallelism plus human drop-in inspection.
5. **Ticket system as input** — the kanban/ticket system becomes the factory entry point; advanced teams write tickets that skip the engineer-translation step entirely.
6. **Factory router** — a router (LLM call or pure code) reads the ticket and picks the specialized workflow; workflows carry distinct cost/performance/speed profiles (hotfixes: expensive models + race multiple sandboxes; chores: cheap models).

Building rules: design by walking the workflow yourself first (map it before encoding it); start with the smallest useful workflow (KISS); move conditions/routing/validation into real code once serious; human stays at the two constraints (planning, final review); specialize aggressively. Mindset: you are building the system that builds the application — factory engineering displaces product engineering.

## Ground truth: where glance sits on each stage (code-verified, main @ 5b0a2d1)

| Stage | Verdict | Evidence |
|---|---|---|
| 1. Atomic unit | **Done** | `glance add` (`src/index.ts:447` `cmdAdd`), web `POST /api/spawn`, voice dispatcher. |
| 2. Agents ⇄ code separation | **Done — implements the prescription literally** | Verify workflow graph `implement → verify → codefix → fixup → escalate → verify` (`src/workflow/verify-workflow.ts`); `verify` runs the repo's detected toolchain (`detectVerifyStages`, `src/intake.ts`); on failure the command output re-prompts the *same lineage* (`FIXUP_PROMPT`), bounded by `maxVisits` (fixups 3, escalate 2), with a deterministic non-AI `codefix` pre-pass. Separate commission gate: `src/validate.ts` (`lintWorker`/`typecheckWorker`/`acceptanceWorker`/`ponytailWorker`, degrading tiers). |
| 3. Specialization | **Partial** | Roles are workflow *nodes* changing prompt on one lineage, not separately dispatched agents. True separation only: TDD `write-test` on `isolatedLineage` (coder can't grade its own test), fan-out branch agents (`workflows/fan-out/workflow.fabro`), daemon-side Scout (`src/scout.ts`) and Observer (`src/observer.ts`) loops. No hotfix/chore/feature expert workflows. Rich role choreography exists but in human-driven skills (blind-review, execute-plan, land-sweep), not daemon code. |
| 4. Isolation | **Worktrees done; sandbox is an opt-in seam** | `src/worktree.ts` universal. `SandboxAgentDriver` (`src/sandbox-agent-driver.ts`) runs the agent in `docker run` (bind-mounted worktree, `--network=none` supported) behind the same `AgentDriver` contract — but default dispatch is host `RpcAgent`. Notably the acceptance gate itself runs *unsandboxed on the daemon host* with a deny-by-default env (`src/validate.ts`, upgrade path noted in-code). Human drop-in (cockpit): `glance open` PR #178 in review; presence/lease endpoints live (`src/authz.ts:109`, `src/schema/http-body.ts:83-94`); the glance-desktop cockpit is mostly open/in-review (`plans/fleet-first-ide/`). |
| 5. Ticket system as input | **Substantially done, deliberately gated** | `Dispatcher.tick` (`src/dispatch.ts`) polls Plane, orders by priority, dedupes via restart-safe `DispatchLedger`, and spawns routed agents (`SquadManager.create({autoRoute, approvalMode:"yolo"})`, `src/squad-manager.ts:1349`) with no human translation — opt-in, and skipping `noAutoDispatch`/blocked issues. Auto-discovered work (Scout/Observer tickets) is hard-quarantined `do-not-auto-land` (`src/scout.ts:107`). The raw-idea→dispatchable-Todo translation (Tier-2 schema: paths, acceptance test, gate, scope) is human-driven skills: plan → plan-to-plane → promote-issue → claim-and-implement. |
| 6. Factory router | **Partial — routes on text + outcomes, not work type; economics in shadow** | Three real routing layers: `routeIntake`/`heuristicRoute` + optional `llmRoute` (`src/intake.ts` → process: verify/plan/fanout/plain + effort, applied `src/squad-manager.ts:4260`); agent profiles (`src/agent-profiles.ts`, chosen by explicit `profileId`, not classification); outcome-matrix model router (`src/model-route.ts` `routeModelForTaskClass`, escalates on merge-rate evidence — gated `OMP_SQUAD_MODEL_OUTCOMES=1` and shadow-first). Cost is ingested (`src/receipts.ts`, `src/attribution-scoreboard.ts`) but `src/cost-gate.ts` defaults off and is warn-only even when on. No best-of-n racing: dispatch is strictly one agent per issue (`src/dispatch.ts:281`); fan-out is 3 *different-strategy* branches + review pick, opt-in via regex/LLM signal. |

**Where the automation actually breaks** (the framework's lens applied): (1) intake translation is human; (2) gate exhaustion parks to a human rather than trying an alternative agent/strategy; (3) high-risk routes to plan+approval and land stays one-tap-human (by design — keep); (4) model/cost intelligence is shadow-only; (5) the cockpit drop-in gesture is unfinished.

**Where glance is ahead of the framework** (do not cargo-cult backwards): outcome-matrix model routing (escalate on *measured* merge-rate edge) beats the framework's vibes-based "hotfixes use expensive models"; bounded escalation with honest parking beats silent retry loops; the `do-not-auto-land` quarantine answers a question the framework never asks — what to do with work the factory *discovers about itself* (Scout/Observer). The framework's building rules (design-by-walking, KISS, code-over-agents, human at two constraints) are already glance operating doctrine — see the merge interlocks (loop never merges) and the fail-open-defense/honesty-as-architecture history.

## Concept extraction

| Concept | Framework's version | glance today | Transferable? |
|---|---|---|---|
| Deterministic nodes + same-session error feedback | Stage 2 prescription | Implemented literally (fixup lineage) | Already done |
| Work-type taxonomy driving lanes | Stage 6 router: hotfix/chore/feature → workflow+model+budget | Routes on task-text regex/LLM → process+effort only; `taskClass` exists as `{mode, tier}` | **Yes — the biggest structural gap** |
| Ticket-to-factory without engineer translation | Stage 5 endpoint: org writes dispatchable tickets | promote-issue is a human-session skill | **Yes — automate the enrichment, keep the human approval tap** |
| Racing sandboxes for hotfixes | Stage 6: expensive lane races multiple sandboxes | Fan-out (3 strategies + judge) exists but opt-in, single workflow unit | **Yes — generalize fan-out into a dispatcher-level lane property** |
| Agent-per-computer sandboxes | Stage 4 endpoint | `SandboxAgentDriver` opt-in; acceptance gate unsandboxed on host | **Yes — flip defaults, containerize the gate first** |
| Cost/perf profiles per workflow | Stage 6: chores cheap, hotfixes expensive | Cost ingested + shadow gate; model router shadow | **Yes — but enforce per-lane, on evidence, not vibes** |
| Specialized expert agents (scout/plan/build/test) | Stage 3 | Nodes-on-one-lineage + isolated tester; skills hold the richer choreography | Partially — the isolated-lineage pattern is the right unit; extend it, don't fragment into micro-agents |
| Design-by-walking, KISS, human-at-two-constraints | Building rules | Operating doctrine already (interlocks, blind-review, plan pipeline) | Already done |

## Ranked transferable concepts (strategist)

**1. Typed work lanes — a work-type taxonomy as the router's key**
**Pattern**: Classify every incoming unit of work into a small closed taxonomy (hotfix / chore / feature / docs / investigation) and let the lane — not per-task improvisation — determine the workflow shape, model tier, retry budget, racing width, and land policy.
**Mechanism**: A classifier (heuristic-first, LLM-fallback — exactly the existing `heuristicRoute`/`llmRoute` shape) stamps a `lane` onto the unit at intake. A lane table (pure code/config) maps lane → `{process, profileId, modelTier, fixupBudget, race: n, landPolicy}`.
**Value for glance**: Today `routeIntake` picks process+effort from task text, `routeModelForTaskClass` keys on `{mode, tier}`, the cost gate has no per-type budget, and retry budgets are global constants. A lane gives all four systems one shared, legible key — and gives the Dispatcher a priority semantics richer than Plane's priority field (a hotfix lane can preempt `maxActive`).
**Where it applies**: `src/intake.ts` (extend `routeIntake` output), `src/model-route.ts` (`taskClass` gains lane), `src/cost-gate.ts` (per-lane budgets), `src/dispatch.ts` (`dispatchOrder`, preemption), `src/squad-manager.ts:4260-4315` (application point already exists). Plane labels can carry the lane so humans/tickets can pre-assign it.
**Build vs buy**: Build — it's ~a discriminated union + table over seams that all already exist.

**2. Autonomous intake promotion — the enrichment agent, human keeps one tap**
**Pattern**: The translation from raw ticket to dispatchable spec (file anchors, acceptance test, verification gate, scope boundary) is itself agent work; the human's role shrinks from *authoring* the enrichment to *approving* it.
**Mechanism**: A daemon-side promoter loop (same shape as Scout/Observer) picks up Backlog tickets, runs the promote-issue choreography (scout the code, write Tier-1 context + Tier-2 schema, baseline the acceptance test), writes the enriched body back to Plane, and moves the ticket to a `promotion-review` state. A human tap to Todo releases it to the Dispatcher. `do-not-auto-land` quarantine semantics stay intact for self-discovered work.
**Value for glance**: Attacks the single biggest human-in-the-middle point the ground-truth sweep found. The entire back half (Dispatcher → verify workflow → autoland) is already autonomous; intake translation is the bottleneck that keeps the factory fed only when Lars is driving a session.
**Where it applies**: New `src/promoter.ts` modeled on `src/scout.ts`; the spec for what "promoted" means already exists as the promote-issue skill (port its checklist into the loop's prompt + a code-side validator that *rejects* enrichments missing an acceptance test — fail closed, per the fail-open-defense lessons). Plane state machine: Backlog → promotion-review → Todo.
**Build vs buy**: Build — the skill is the spec; this moves it from session choreography into daemon code, which is precisely the framework's "separate code from agents once serious" rule.

**3. Containerize the gate, then default agents into the sandbox**
**Pattern**: The factory's trust boundary must not depend on agent-authored code behaving; everything that *executes* candidate code runs in a disposable container, and autonomous (yolo) agents get sandboxes by default.
**Mechanism**: Step 1: move `acceptanceWorker`/gate execution into the same docker harness the gate sandbox already uses — the in-code note in `src/validate.ts` names `SandboxAgentDriver` as the upgrade path. Step 2: flip auto-dispatched units (`approvalMode:"yolo"` from `Dispatcher`) to `SandboxAgentDriver` by default, host driver opt-out.
**Value for glance**: The sweep found acceptance runs *unsandboxed on the daemon host* — agent-authored code executed with only env-scrubbing between it and the operator's machine. As intake automation (concept 2) widens what reaches dispatch, this gap compounds. Also the precondition for the cockpit's "jump into any sandbox" end state (fleet-first-ide).
**Where it applies**: `src/validate.ts` (acceptance execution), `src/sandbox-agent-driver.ts` (default for dispatcher spawns in `src/squad-manager.ts:1349`), `src/dispatch.ts`.
**Build vs buy**: Build — both halves exist as code; this is defaults and wiring, not new machinery.

**4. Racing as a lane property — generalize fan-out into dispatcher-level best-of-n**
**Pattern**: For work where latency-to-correct matters more than cost (hotfixes, land-blocked escalations), dispatch N isolated agents on the same ticket and let a judge (or first-past-the-gate) pick; cancel the rest.
**Mechanism**: Lane table (concept 1) carries `race: n`. Dispatcher spawns n units against one issue in separate worktrees; a review node — the exact judge shape `workflows/fan-out/workflow.fabro` already has — picks the winner; losers' worktrees are swept. Second application: on gate exhaustion, instead of parking immediately, one racing round with different strategies (the fan-out prompts: simplicity/performance/minimal-deps) before escalating to a human.
**Value for glance**: Converts the "gate exhaustion parks to human" break-point into one more autonomous rung, and gives the hotfix lane the speed profile the framework prescribes. Fan-out is ~80% of the machinery; the missing 20% is dispatcher-level issue↔multiple-units bookkeeping (`DispatchLedger` currently assumes 1:1, `src/dispatch.ts:281`).
**Where it applies**: `src/dispatch.ts` (ledger + spawn), `workflows/fan-out/` (judge reuse), `src/squad-manager.ts` (`fileLandBlockedEscalation` gains a race-first option).
**Build vs buy**: Build.

**5. Flip the economic intelligence out of shadow — per-lane, on evidence**
**Pattern**: A router without enforcement is a dashboard. Once lanes exist, cost budgets and model escalation should *bind* per lane: chores get hard cheap-model budgets, hotfixes get standing escalation permission.
**Mechanism**: `src/cost-gate.ts` enforce mode (deliberately deferred until now) keyed to lane budgets; `src/model-route.ts` apply-mode per lane once its shadow log shows the matrix is sane. Keep glance's evidence discipline: enforce only where the outcome matrix supports it — this is where glance should *diverge* from the framework's static "expensive model for hotfixes" and keep measured escalation.
**Value for glance**: The scoreboard (`costPerLandedChange`) becomes a control signal instead of a display. Depends on concept 1 for the key; sequenced last deliberately.
**Where it applies**: `src/cost-gate.ts`, `src/model-route.ts`, `src/attribution-scoreboard.ts`.
**Build vs buy**: Build — flag flips + lane budgets over shipped machinery.

**Not adopted**: Stage 3's "specialize aggressively into scout/plan/build/test micro-agents" as separately dispatched roles. glance's isolated-lineage-within-one-workflow pattern (the TDD tester) already captures the grading-independence benefit without the context-fragmentation cost, and the blind-review history shows the value is in *independent judgment*, not in more agents. Extend isolated lineages (e.g. an isolated reviewer node) case by case instead.

## Recommendation

All five concepts are borrow-the-pattern; nothing to adopt as a dependency (the source is instructional material, not a tool). Suggested sequencing if this chains to /plan: 1 (lanes) → 2 (promoter) and 3 (sandbox defaults) in parallel → 4 (racing) → 5 (enforcement). Concept 3 should not wait long regardless — it is a live security gap on the daemon host that widens with every step toward fuller intake automation.
