# omp-squad — Meta-Harness North Star
STATUS: charter
PRIORITY: p0 (vision — gates plan prioritization, does not itself ship)
REPOS: omp-squad
SOURCE: authored as a goal-oriented prompt; intended as the input to `/plan` and as the standing charter
TRACKING: this file is the source of truth for the vision; the "Coverage & gaps" section maps it to live plans.

> **Mission.** Become the git of autonomous agent work — the open, local-first protocol layer that governs
> heterogeneous agents at any scale, on compute you control, in a federated peer mesh nobody owns.
>
> Intelligence is already commoditizing: Llama, Mistral, and their successors run on hardware you own. What
> remains scarce — and grows more scarce as agents proliferate — is the **governing substrate** that makes
> autonomous work verifiable, auditable, and trusted. We build that layer. We do **not** build a competing
> runtime — omp, ACP (Claude Code/Codex/auggie), and Flue workers are the runtimes; local and frontier model
> tiers are the intelligence supply. We build the **protocol layer ABOVE them**: the append-only chokepoint
> between intent and consequence that, at civilizational scale, becomes infrastructure the way TCP/IP and git
> are infrastructure. The labs build on top of it. No vendor owns it. It runs on your compute.

## North star (one sentence)
The open, local-first governing substrate for autonomous agent work — any agent, any model tier, any
operator, any scale — where every action is verifiable from first principle, every result is
provenance-chained to the policy that authorized it, runs on compute you own, and no vendor owns the
coordination layer.

## What already exists — extend these seams, do not rebuild
- **Universal runtime seam:** `AgentDriver` already unifies omp (`RpcAgent`), ACP (`AcpAgentDriver`),
  sandboxed agents (`SandboxAgentDriver`), Flue workers (`FlueServiceDriver`), and workflow graphs
  (`WorkflowDriver`). This is the wedge — make it the universal adapter.
- **One event spine:** `SquadEvent` stream → TUI + web are thin clients of the same core.
- **One authz chokepoint:** every mutation flows through `applyCommand(cmd, actor)` with tiered roles
  (viewer/operator/admin/local) + an append-only audit log.
- **Coordination primitives:** `FederationBus`/`TailnetFederationBus`, presence + soft file leases
  (`ttl-registry`, heartbeat-TTL, cross-host repo identity), collision detection. (Roster agents do NOT yet
  message each other — that primitive is Pillar 1 / `plans/agent-context-fabric/`.)
- **Orchestration:** `WorkflowEngine` (.fabro DOT graphs, human gates, fan-out/merge), self-healing
  `Orchestrator` (auto-land/self-heal/catastrophe/admission), `Scheduler` (WIP cap), `resolver`
  (retry/hold/escalate), restart-safe ledgers (`orchestrator-state`, `land-ledger`).
- **Accounting + memory:** `receipts` (tokens/cost/files), `digest` (zero-token resume), `summarizer`.
- **Multi-tenancy:** DbStore with per-org RLS + audit table; FileStore for single-tenant.
- **Factory:** the commission loop (`architect` → `worker-template` → `validate`) authors Flue workers.
- **Self-observation loop:** `observer` audits operational fleet state (red gate, stale branches, land
  failures) and files findings as Plane issues (auto-fix / auto-dispatch capable); `scout` harvests agent
  *reasoning* into latent backlog items. The harness already diagnoses itself and generates work.
- **Context-heat graph:** `dal/context` tracks which code areas ran hot across runs (decaying half-life).
- **Autonomous conflict resolution:** `AUTORESOLVE` + the `resolve-conflict` workflow resolve merge/rebase
  conflicts during land — the bottleneck of N-way fan-out.
- **Resource governance:** a host watchdog + load-aware admission backoff (RSS / load-per-CPU ceilings)
  bound host pressure under heavy fan-out.
- **Auth stack:** better-auth + per-org RLS + operator/viewer token tiers + signup gating + org-idle
  eviction (DB mode) — the enterprise auth foundation already exists.
- **External work intake:** Plane-driven dispatch + autoclose + a rate-limit/gateway layer — the
  issue-tracker is already a first-class work source.
- **Named agent profiles:** `intake`/`smart-spawn` already selects runtime + model; the missing primitive
  is a versioned named profile file — persona, system-prompt overlay, capability grants, spawn policy,
  memory pointer. This is the "Expert" from Cosmos, adapted: local-first, version-controlled, no SaaS
  required. Extend `intake`; do NOT build a second spawn path.

- **Intelligence tier:** local models are the default compute substrate; frontier models are an escalation
  path for tasks that require it. The harness routes based on task intent-density and the receipts cost
  ledger — not vendor pricing, not model prestige. Intelligence is a commodity input. Governance is the
  scarce layer. `smart-spawn` owns the routing decision; `receipts` owns the ledger. No new mechanism.

Every new capability MUST attach to one of these seams and reuse it. A second mechanism beside an existing
one is a defect.

## Pillar 1 — Agent-to-agent contextualization + introspection (the differentiator)
Agents stop being islands. They **communicate in a hierarchy**, **introspect a shared context**, and that
introspection **surfaces patterns and product-enhancement opportunities** the harness feeds back into itself
— a self-improving loop. The introspection engine is half-built: `scout.ts` already harvests each working
agent's reasoning into latent items, `observer.ts` audits operational state, `dal/context.ts` holds a
cross-run heat graph. The missing halves are *communication* and *aggregation*.
- **Communication** — a typed inter-agent message primitive (a new `ClientCommand` variant; today none
  exists — agents are steered only by operators) routed through the `applyCommand` authz+audit chokepoint and
  delivered to the target as fenced, redacted, advisory context. Hierarchy-aware: address a parent, children,
  or a peer group.
- **Hierarchy** — promote `parentId`/`featureId`/`owns` from structural metadata into a routing+permission
  model (coordinator → workers → peers) that scopes who may message and introspect whom; promote the
  auto-supervisor from "answer blocked gates" to "observe and direct its sub-fleet."
- **Introspection / context fabric** — a typed, queryable view over distilled per-agent state (what I'm
  doing, touched, learned, need, produced — extend `digest`/`summarizer`), the reasoning harvest (`scout`),
  the heat graph (`dal/context`), and leases — facts with provenance, not raw transcripts. Context handoff on
  spawn/branch/land so a successor starts primed.
- **Patterns → opportunities** — promote `scout` from per-agent items to cross-agent/cross-run clustering:
  recurring friction, duplicated effort, hot/churny areas, common failure modes → emit deduped
  **enhancement/opportunity** issues (reuse the Scout/Observer→Plane filing) + a dashboard surface. This is
  how introspection "iterates on the product."
- **Heterogeneous + collision-free** — speak A2A/ACP so distinct runtimes coordinate as peers; extend
  leases/presence so overlapping edits surface before duplication, cross-host.
- **Cross-session expert memory** — extend `digest`/`summarizer` to be profile-scoped, not just
  session-scoped. A named profile's memory survives across sessions and is injected as fenced, redacted
  context on spawn. `ponytail:` append-only markdown per profile dir; ceiling is contention on high-frequency
  profiles; upgrade path → structured KV per profile if needed.
- **In-layer boundary:** distilled cross-agent facts + handoff + heat — NOT live context-window management
  (omp's job). **Safety:** every peer message is untrusted input (fence + redact + authz + budget cap).
- **Acceptance bar:** B continues from A's context without re-deriving it; a coordinator addresses its
  sub-fleet; a recurring pattern across ≥N runs surfaces ONE opportunity (not N tickets); a heterogeneous
  roster (≥2 runtimes) coordinates on one feature; zero-clobber across parallel edits.
- **In flight:** `plans/agent-context-fabric/` (C1 comms · C2 hierarchy · C3 fabric · C4 pattern→opportunity).

## Pillar 2 — Orchestration (durable, policy-driven, self-healing)
Launch-and-trust: define intent; the harness drives it to a verified, landed result across repos and
operators, surviving crashes and selecting for quality.
- Durable, process-independent workflow execution (resume any run after a full crash, exactly once).
- Quality-selected fan-out (best-of-N tournaments with scored gates), not just redundancy.
- Typed human-in-the-loop: every pause carries a typed reason + expected-answer schema; the UX renders it
  generically; the answer flows back into run state.
- **Model-tier-aware orchestration (Hybrid Local-First)** — route tasks across local and frontier models
  based on intent-density: local models for bulk execution/isolation, frontier models for high-reasoning
  coordination or final verification. Manage the "escalation" policy automatically.
- Capacity- and cost-aware admission across the fleet; policy-routed failure with bounded repair budgets and
  restart-safe decisions.
- Autonomous merge/rebase **conflict resolution** during land (`AUTORESOLVE` + the `resolve-conflict`
  workflow) — the real bottleneck of N-way fan-out, not just the merge.
- Cross-repo and cross-operator orchestration.
- **Acceptance bar:** `kill -9` the daemon mid-graph → the run resumes and lands without re-doing or
  duplicating committed work; an N-way tournament lands the highest-scoring passer; a goal spanning 2+ repos
  lands atomically-or-cleanly.

## Pillar 3 — Higher-level diagnostics (see everything, know why, know the fix)
An operator answers "what's stuck, why, and what to do" in one glance — for one agent or a thousand, local or
federated.
- A span/trace tree across the lifecycle (spawn → each workflow node → verify → land → resolve), with
  sampling to bound cost and tags/metadata for filtering (extend `receipts` + `StageEvent` + subagent tree).
- Scorers/evals as quantifiable quality signals, live or over historical traces, with regression tracking.
- Anomaly + root-cause surfacing: name the likely cause and the next action, not a log dump. Seeded today by
  the `observer` (operational audit → Plane) + `scout` (reasoning harvest); the gap is the unified trace tree
  + export — `plans/fleet-observability/`.
- Cost/token/throughput accounting per agent/feature/operator/org, queryable and exportable.
- A pluggable export seam (OTel/Langfuse/Datadog) for enterprise observability stacks.
- **Acceptance bar:** a deliberately-stuck agent is flagged with a correct cause + suggested action; a quality
  regression across runs is detected from stored scores; a full feature trace renders as one navigable tree
  with cost rolled up.

## Enterprise-grade (table stakes that gate adoption)
- Multi-tenant isolation: the per-org RLS + audit + token-tier auth foundation already exists (better-auth,
  DB mode). The gaps are RBAC depth beyond viewer/operator/admin, unifying federation identity (tailnet
  `whois` → the same IdP), and delegation/availability policy. `plans/mt-isolation/` (6× p0 — the critical
  path) owns the per-org `SquadManager` isolation.
- Audit every cross-operator action; secret-shape redaction before persist/display; keep SSRF + supply-chain
  guards load-bearing.
- HA/durability: single-writer locking, clean self-upgrade handoff, crash-supervised resume, no silent data
  loss.
- **Capabilities model** — named, composable tool grants (GitHub read, Plane write, host FS write, network
  egress) attached to a named agent profile and enforced at the `applyCommand` chokepoint. Per-org,
  revocable, audited. Extends the existing token-tier auth; not a replacement. Cosmos's capability-grant
  model, adapted local-first.
- Governance UX: who did what to whose agent, policy config, compliance export.
- **Acceptance bar:** a remote operator can only do what their verified role permits (never self-grant);
  every cross-operator action is audited; a tenant cannot observe or touch another tenant's fleet.

## The defined user experience (flawless in both TUI and web)
- **Spawn:** one line of intent + optional profile name → right runtime/model/approval/isolation/workflow
  chosen (extend `intake`/`smart-spawn`), with peer context + profile memory attached.
- **Glance:** a live board — working/idle/needs-input/error, activity, todo progress, context-window %, cost
  — across local AND federated fleets.
- **Steer:** dive into any agent; instruct, answer typed prompts, interrupt/restart/kill, from anywhere; both
  surfaces stay in sync off the one event stream.
- **Be-asked:** approvals, the `ask` tool, host-tool calls, and workflow human-gates surface as needs-input
  with inline typed answer controls — never missed.
- **Diagnose:** from the board, one step to the trace tree, the root cause, and the recommended action.
- **Hand-off & federate:** a teammate's away agent can be steered under delegation policy with full context
  and full audit.

## Kill criteria (testable obsolescence bars)
1. **Heterogeneity** — omp + Claude Code + Codex + arbitrary ACP/A2A in ONE roster, one UX.
2. **True parallelism** — N worktree-isolated agents, zero clobber, quality-selected merge.
3. **Survivability** — any run resumes exactly-once after a hard crash.
4. **Contextualization** — agents build on each other's distilled context, not raw logs.
5. **Diagnosability** — one-glance fleet health with root cause + next action.
6. **Federation + governance** — cross-org coordination with verified identity, RBAC, full audit.
7. **Hybrid local-first compute** — local model runs the bulk; frontier escalation is policy-driven,
   audited, and optional. A run that could have used a local model never silently calls a frontier API.
8. **Verifiable provenance** — any action taken by any agent can be reproduced from the local ledger alone,
   without contacting a vendor. The audit trail is self-contained.

## Constraints (non-negotiable)
- Follow the AGENTS.md ponytail ladder: smallest correct change, stdlib/native/existing-dependency before new
  code, extend a seam before adding a mechanism, shortest working diff. Mark deliberate simplifications with
  `ponytail:` comments naming the ceiling + upgrade path.
- Build the pattern; borrow a dependency only for genuinely hard problems (crypto, consensus, OTel export
  edge, A2A spec). Do not adopt a competing framework wholesale.
- Every behavior ships with ONE runnable check and its docs in the same change.
- Security, isolation, authz, audit, accessibility are NEVER simplified away.
- TUI and web are thin clients of one core; never let them diverge.

## Non-goals
- Not a new agent runtime, model router, RAG store, voice stack, or generic SaaS platform.
- Not a transcript firehose UI — context is typed/distilled; diagnostics are root-caused.
- No capability that doesn't attach to an existing seam or serve one of the three pillars.

## Output when handed to `/plan`
A phased, dependency-graphed plan sequencing the three pillars + enterprise hardening into independently
landable concerns, each with: the seam it extends, the acceptance bar it must pass, a deterministic
verification gate, and explicit scope boundaries. Reuse `durable-workflow-resume` and `best-of-n-selection`
as in-flight foundations rather than re-planning them.

---

## Coverage & gaps (vs live plans / worktrees / contexts — 2026-06-24)

Compared the charter against all 12 plan dirs, the 6 live git worktrees, the running daemon's
state/contexts, and `.env.example`. Roster is currently empty (no squad-managed agents live now); the
worktrees below are the active build threads, and `~/.omp/squad/{digests,receipts}` show many historical
`OMPSQ-NN` Plane-tracked runs.

### Pillar coverage matrix
| Pillar | Covered by (status) | Verdict |
|---|---|---|
| **1 — A2A contextualization** | auto-supervisor (live: one agent answers another's block), federation presence/leases (live), `digest`/`summarizer` (live), context-heat graph (live), `subagents` tracker, `irc`, worktree `scout-reasoning-harvester` (in-flight) | **THINNEST vs its prominence — no dedicated plan.** The headline differentiator is only covered incidentally. |
| **2 — Orchestration** | `durable-workflow-resume` (planned), `best-of-n-selection` (in_progress), `netnew-land-gate` (done), autonomy loops + auto-resolve + repair-budget (live) | Strong; durable-resume is the open net-new. |
| **3 — Diagnostics/UX** | `squad-ui-ux` (7/7 done), `omp-dashboard` (12 done), `omp-graph-ui` (7 done), `omp-planner` (5 open), observer→Plane loop (live), `receipts`/`audit`/`vision` (live) | UX surface mature; the **unified trace-tree + scorers + root-cause + OTel export is unplanned.** |
| **Enterprise** | `mt-isolation` (6× p0 TODO), better-auth + per-org RLS + viewer/operator tokens (wired), audit (live), watchdog/resource-gate (live), `archil-mt-pilot` durability (fsync+unclean-stop done; PARKED) | Foundation real; **`mt-isolation` is the critical path and not yet built.** |

### North-star BLIND SPOTS — real capabilities the charter failed to name (fold these in)
1. **Self-observation loop** — the live `observer` already watches the fleet and *files findings as Plane
   issues* (can auto-fix / auto-dispatch). A closed diagnose→file→fix loop the meta-harness should claim
   under Pillar 3, not just trace-trees. (worktree `fix/observer-issue-lifecycle`)
2. **Reasoning harvesting** — `scout-reasoning-harvester` (live worktree + `scout-seen.json`) mines agent
   reasoning. Directly serves Pillar 1 (capture what agents learned) + Pillar 3 (root-cause); the charter
   omitted it entirely.
3. **External work-source intake + generalized triggers** — work intake is already issue-tracker-driven
   (Plane dispatch + autoclose + the `plane-throttle`/gateway scaling concern, worktree
   `feat/plane-rate-limit-layer`). Extend to a generic trigger router: webhook (GitHub, Slack, Linear,
   custom HTTP), scheduled cron, file-watch → `applyCommand` dispatch. Per-org subscription config. The
   `intake` seam is the landing point; the work is the trigger router. Cosmos's automation trigger model,
   adapted local-first. No plan dir yet (→ G5).
4. **Auth is further along than stated** — better-auth + DB RLS + token tiers + signup gating + org-idle
   eviction are wired. The real gap is RBAC depth + unifying federation identity, NOT greenfield auth.
5. **Resource/host-pressure governance** — watchdog + load-aware admission backoff + RSS/load ceilings (live)
   bound host pressure under heavy fan-out. A concrete operability differentiator; add to the enterprise pillar.
6. **Autonomous conflict resolution** — `AUTORESOLVE` + the `resolve-conflict` workflow resolve merge/rebase
   conflicts during land. The bottleneck of N-way fan-out; Pillar 2 must name it.
7. **Self-extension (the factory)** — the commission loop authors *new* Flue workers (`architect` →
   `worker-template` → `validate`). A meta-harness superpower (it builds its own agents); elevate it from
   "what exists" to a named capability.
8. **Context-heat graph** — cross-run heat map of which code areas ran hot (churny/risky). A
   contextualization + diagnostics primitive the charter didn't name.
9. **Named agent profiles (Experts)** — `smart-spawn` picks a runtime but there is no versioned, named
   profile primitive (persona + system-prompt overlay + capability grants + memory pointer). Cosmos's
   "Expert" adapted local-first. Fold into the "Spawn" UX moment; extend `intake`. No plan yet.
10. **Capabilities model** — no structured tool-grant system exists; permissions are coarse token tiers.
    Named grants attached to a profile, enforced at `applyCommand`, audited. Fold into Enterprise. No plan
    yet.

### UNPLANNED gaps the charter asserts but nothing plans yet (candidates for `/plan`)
- **G1 — IN FLIGHT** (delegated 2026-06-24 → `plans/agent-context-fabric/`): Pillar-1 agent-to-agent comms +
  hierarchy + introspection context fabric + pattern→opportunity loop. Seed: `scout` reasoning harvest.
- **G2 — IN FLIGHT** (delegated 2026-06-24 → `plans/fleet-observability/`): span/trace tree
  spawn→node→verify→land→resolve + sampling + cost rollup + OTel export seam. (Scorers → `best-of-n-selection`;
  reasoning/opportunity → G1.)
- **G3: Federation remote-steering + delegation/availability policy** — README names it as the remaining
  Phase-2 work (receive side exists; nothing *sends* a command frame); no plan dir.
- **G4: Heterogeneous A2A interop** — speak the A2A protocol as a federation/peer wire format (ACP runs only
  *as an agent* today). Folds into G1.
- **G5: Generalized event triggers** — extend the Plane-poll intake to a generic trigger router: webhook
  (GitHub, Slack, Linear, custom HTTP), scheduled cron, file-watch → `applyCommand` dispatch. Per-org
  subscription config stored in FileStore/DbStore. The `intake` seam is the landing point. Cosmos's
  automation trigger model, adapted: self-hosted by default, no managed integrations required.

### Cosmos parity — deliberately ripped and adapted (2026-06-24)
The following Cosmos primitives were reviewed and adopted in adapted form. Each maps to an existing seam;
none requires a new mechanism.

| Cosmos primitive | What we adopt | Where it lands | What we skip |
|---|---|---|---|
| **Experts** | Named, versioned agent profile: persona + system-prompt overlay + capability grants + memory pointer | Extend `intake`/`smart-spawn`; profile files in repo (B9) | Cloud VM provisioning per expert |
| **Capabilities model** | Named, composable tool grants per profile; enforced at `applyCommand`; audited | Enterprise tier; extend token-tier auth (B10) | Cosmos's managed capability marketplace |
| **Expert memory** | Per-profile persistent memory dir injected as fenced context on spawn; extend `digest`/`summarizer` | Pillar 1 context fabric | Cross-org memory sync / SaaS memory store |
| **Generalized triggers** | Webhook/cron/file-watch → `applyCommand` dispatch; per-org subscription config | G5; extend `intake` seam | Cosmos's managed app installs (Slack app, GitHub app) |

| **Multi-tenant SaaS** | `mt-isolation` plan (6× p0 critical path) | Enterprise tier | Generic managed infra / SaaS hosting |

### Competitive Landscape — funded market signals (2026-06)
The meta-harness layer is now a crowded VC category. We differentiate by planting on the "local-first /
verifiable" corners that centralized SaaS cannot occupy.
- **The Rulers (Governance & Coordination):** Sycamore ($65M seed), Arcade ($60M), Geordie ($30M), and BAND
  ($17M) are all building "trusted agent operating systems" or "coordination layers." **Risk:** commoditization
  of the generic "control tower." **Response:** focus on **Provenance** and **Verifiable Landing** (Gates) as the
  product, not the dashboard.
- **The Memory-Makers:** Engram ($98M @ $600M) and Trajectory ($15M) are pricing "learned per-org memory" as the
  durable moat. **Response:** Reframe Pillar 1 around the **Proprietary context fabric** (`scout` corpus +
  heat graph) as a data asset, not a messaging protocol.
- **The Local-First Hedge:** Tsuga ($35M) and Archestra ($10M) are the only major players explicitly claiming
  "data never leaves your cloud." **Response:** Double down on **Local-First / Local-Model** orchestration as
  our primary compute substrate.

### Tensions to encode (so the vision doesn't overreach)
- **Durable spans two layers**: workflow-graph resume (durable-workflow-resume) **and** agent-level human
  escalation durability (humanlayer-baml-uplift `03-off-dashboard-escalation`, F7). omp agents are *attached
  children*, not day-long detached threads — "suspend indefinitely" lives at the workflow layer, not the agent.
- **Federation = cross-OPERATOR, not cross-DEVICE**: "runnable wherever development happens" must not drift
  into same-operator personal device sync (explicitly out of scope per the HumanLayer research).
- **Pillar 1 stays in-layer**: distilled cross-agent facts + handoff + heat, NOT live in-flight context-window
  management — that's omp's job, not the control plane's.
- **`mt-isolation` is the enterprise critical path**: the enterprise pillar is aspirational until its 6 p0
  concerns land.

### Recommended next `/plan`
G1 + G2 are **now in flight** (delegated 2026-06-24 as parallel plan agents). With the strategic spine
locked (see "Decisions locked"), the top UX candidate is now the **manager-grade fleet board +
conversational-config surface** (the Cursor-lesson direction) — built on the existing
`intake`/`smart-spawn`/`applyCommand`/event-spine seams, gated by named agent profiles (B9) + capabilities
model (B10), since the control-tower LLM composes exactly those. Other candidates: **G5** (generalized event
triggers — feeds the board as code-producing inputs), **G3** (federation remote-steering + delegation/
availability policy), and **G4** (A2A protocol interop, folds into G1). `mt-isolation` (6× p0) remains the
enterprise critical path to schedule.

---

## Strategic horizon — load-bearing assumptions that may not hold (2026-06-24)
The charter above is internally coherent. This section stress-tests its *frame* against a 3–5 year horizon
in which agents get materially more capable and more numerous, and intelligence commoditizes. Six assumptions
are doing silent work; if they break, the pillar ordering changes, not just the prose.

1. **The operator is the governing layer.** Every UX verb (Spawn/Glance/Steer/Be-asked/Diagnose/Hand-off)
   assumes a human is the throughput limiter the harness exists to accelerate. As agents become reliable
   enough that a human watching N agents is the bottleneck (not the safeguard), the value shifts from
   "one glance for an operator" to **agents governing agents under policy, human on exception + audit only**.
   We half-build this (`auto-supervisor`, `observer→file→fix`) but keep the operator central. Push it
   further: the future board is read by another agent, and the human reads the audit log on policy trips.
   At the inversion point — when agent-hours of economic output exceed human-hours — the harness IS the
   operator. The UX is the policy config, not the dashboard.
2. **Pillar 1's *protocol* is the differentiator.** Typed A2A messaging / shared context is being
   commoditized by the model labs (MCP, A2A, vendor multi-agent stacks). If the wire format is vendor-owned,
   our "context fabric" is a thin adapter. The durable asset is the **proprietary cross-run data** —
   `dal/context` heat graph + `scout` reasoning harvest + the pattern→opportunity corpus. No lab has *your*
   fleet's history on *your* codebase. Reframe Pillar 1 around the data asset (the moat), not the messaging
   primitive (the commodity). Market signal: Engram ($98M, Jun-26) prices "learned per-org memory" as the
   moat; Trajectory / Modiqo fund continual-learning agents. Memory-as-moat is being priced now.
3. **`Isolated by default` = git worktree.** This silently bets code stays the unit of work. G5's
   webhook/Slack/incident triggers already break that assumption. Make the bet explicit: either declare "we
   are the *coding* meta-harness, code is the unit" (narrower, defensible) or solve isolation as an
   abstraction above worktrees (broader, harder). Do not leave it assumed.
4. **Verification is a CI step.** At scale the binding civilizational constraint is not "produce work" but
   **"trust the output without re-deriving it."** `best-of-N` with an LLM judge is theater. The durable
   position is **verifiable agent work**: deterministic gates, property/formal verification, proof-carrying
   landing — "we don't trust agents, we verify them." Promote verification from plumbing to a pillar. Market
   signal: Geordie ($30M), Canyon Code, Tribal AI, NanoCo ($12M sandboxed), Arcade ($60M) — trust is where
   capital is moving.
5. **Intelligence is a vendor asset.** This assumption is already breaking. Frontier models (GPT, Claude,
   Gemini) will remain best-in-class for high-reasoning peaks. But the majority of agent work — file
   manipulation, code generation, summarization, routing — is already within reach of local models running
   on commodity hardware (Llama, Mistral, Qwen, Phi). The shift: **intelligence becomes a commodity input,
   like bandwidth or storage.** The harness that routes local vs. frontier based on task value-density
   captures the cost arbitrage while keeping provenance on local compute. `receipts` has the data; the gap
   is the routing policy in `smart-spawn`. This is the compute sovereignty wedge: as intelligence
   commoditizes, whoever governs the routing layer governs the cost and the audit trail.
6. **Agents are a coding tool.** The charter's entire framing — worktrees, PRs, land gates, merge conflicts
   — assumes the unit of agent work is a code change. Local models break this assumption by making
   deployment cheap enough for every domain: research, ops, finance, legal, infrastructure. G5's triggers
   (Slack webhooks, incident alerts, scheduled cron) are the first crack. The governance model — `applyCommand`,
   typed roles, append-only ledger, capabilities — generalizes to any autonomous work, not just code. Either
   declare the coding scope explicitly and own it as a deliberate constraint, or stake the broader claim:
   **verifiable governance for all autonomous work**. The broader claim is the trillion-dollar version.

### The civilizational position
Three irreversible arcs are converging. They point at a single architectural conclusion.

**Arc 1 — Intelligence commoditizes.** Local models (Llama, Mistral, Phi, and their 2027 successors) will
handle 80%+ of agent tasks on hardware you own. Frontier labs will remain essential for the top 20% of
reasoning demand — the hard problems, the final verification, the strategic coordination — but they lose
their stranglehold on the intelligence layer. What happened to storage (S3 pricing → ~0), bandwidth (CDN →
~0), and compute (serverless → ~0) will happen to inference. When intelligence is priced like bandwidth, the
value moves entirely to the **governance and coordination layer above it**.

**Arc 2 — Regulatory inevitability.** The first major autonomous-agent incident — financial, medical,
infrastructure — triggers mandatory audit requirements before 2030. "Show your agent's work" becomes law,
not preference. The companies that cannot produce a complete, tamper-proof, locally-held audit chain for
every agent action will be uninsurable and non-compliant. Centralized SaaS audit logs (vendor-held,
vendor-deletable, vendor-priced) will fail this test. The only architecture that survives regulatory
scrutiny at scale is the one where **the audit ledger runs on your infra and is reproducible from first
principle**.

**Arc 3 — Sovereignty concentrates.** Enterprises and governments will not route their agent governance
through a centralized SaaS control plane. The EU AI Act, US executive orders, and enterprise procurement
requirements are already moving in this direction. The demand for "runs on our infra, under our policy,
with our model weights" will become non-negotiable in regulated industries, national governments, and any
org that has watched what vendor lock-in costs. The centralized vendors (Cosmos, Sycamore, Geordie, BAND)
are structurally incapable of satisfying this demand — it requires giving up the billing relationship and
the data.

**The conclusion:** the architecture that survives all three arcs simultaneously is exactly what omp-squad
already is, and just needs to claim: **a local-first, federated, open protocol for governing autonomous agent
work**. Runs on your hardware. Verifiable from the ledger alone. Federated without a center. Nobody rents it
to you.

### The git analogy (the structural bet)
Git won by making version control **local-first, distributed, and un-ownable**. Before git: CVS/SVN were
centralized, vendor-controlled, network-dependent. After git: the intelligence (the merge algorithm, the
diff engine) is free, runs everywhere, nobody can charge rent on it. The value moved to the collaboration
layer (GitHub/GitLab), but **the protocol layer is what made the entire ecosystem possible**. Every lab,
every IDE, every enterprise system eventually built on top of git, not beside it.

The same arc is playing out in AI governance:
- Before local models: frontier labs own the intelligence → vendor lock-in → cloud dependency
- After local models: intelligence is commodity → value shifts to governance/coordination layer
- The labs will build their platforms (GitHub-equivalent) on top of whatever governance protocol wins
- **The protocol that wins is the one that is local-first, open, and un-ownable**

omp-squad's structural bet: **be git, not GitHub**. The open governance protocol the platforms build on.
The thing that cannot be acquired, priced, or deprecated because it runs on your hardware and belongs to
no one.

### Reframed bet (bigger than "Cosmos killer")
"Cosmos killer" was always a small target — beat one vendor's cloud product. The real target is the
architectural position that **no centralized vendor can take**, because taking it requires surrendering the
business model:

- **Un-rentable intelligence routing** — local model is default; frontier is a policy-gated escalation.
  The harness captures the cost arbitrage and owns the audit trail on your compute. No vendor can copy
  this without giving up their API revenue.
- **Self-contained provenance ledger** — `applyCommand` chokepoint, append-only, reproducible from local
  state alone. When regulation demands "show your agent's work," the answer is a local file, not a vendor
  API call. No SaaS can match this without ceasing to be SaaS.
- **Verifiable landing as the product** — the gate IS the deliverable. "Provably safe to merge" replaces
  "probably fine to review." Formal/property verification promoted from CI plumbing to the value claim.
- **Federation without a center** — `TailnetFederationBus` + leases already exist. Labs/Cosmos pull toward
  centralized control planes. The hedge is a local-first peer federation standard — an architectural stance
  about *who owns the coordination layer*, not a feature. If omp-squad federates like git remotes, not
  like Slack workspaces, it cannot be acquired into irrelevance.

### Decisions locked (2026-06-24)
The three strategic bets the horizon left open are now decided. The spine is fixed; plans inherit these.

1. **Operator-centric: YES — a control tower you talk to.** The end state is not "dashboard vs. policy
   file" — it is both, collapsed. The manager *glances* at a live fleet board (the control tower) and
   *configures by conversation*: a control-tower LLM that composes spawn policy, named profiles,
   capability grants, and escalation rules from plain intent — no settings panels, no rule-file authoring.
   The human writes policy by talking; the LLM emits the structured config into the existing
   `intake`/`smart-spawn`/`applyCommand` seams. The dashboard is the read surface; the conversation is the
   write surface. Both render the same core.
2. **Coding scope: YES — code is the unit, worktree is the substrate.** We are the *coding* meta-harness.
   Worktree isolation stays the isolation primitive; we do NOT abstract above it (assumption #6's
   trillion-dollar expansion is explicitly declined). G5's non-code triggers are *inputs that produce code
   changes*, not a generalization of the work unit. Narrower, defensible, shippable.
3. **Open: YES — be git, not GitHub.** The protocol layer (the `applyCommand` chokepoint, the event spine,
   the federation bus, the receipts/provenance ledger) is open. The git analogy is the actual bet, not a
   metaphor. Value capture, if any, lives in the collaboration/hosting layer above — never in renting the
   protocol.

### Manager-level IDE — the Cursor lesson (the UX north star)
The single decided thesis: **engineers become fleet managers.** The IDE's center of gravity moves from
*the file I'm editing* to *the roster I'm directing*. The verbs shift from write/edit/debug to
delegate/review/steer/verify. Cursor already proved the market accepts this shift; we learn from its UX and
plant one level above it.

**What Cursor got right (adopt the pattern, not the product):**
- **Agent-centric layout** (2.0, Nov-25): agents/plans/runs are first-class sidebar objects; files demote
  to pills inside conversations. → our **Glance** board is this primitive; make agents (not files) the
  center of the web/TUI.
- **The Agents Window** (3.0, Apr-26): one surface where agents from every origin (local, worktree, cloud,
  remote, Slack, GitHub, Linear) appear in a single roster. → exactly our multi-runtime roster + event
  spine; the gap is the *manager-grade board*, not the substrate.
- **Tiled multi-agent view + `/multitask` fan-out** (3.2): watch N agents side-by-side; chop a task across
  a subagent fleet. → maps to `smart-spawn` + `Scheduler` fan-out; the gap is the side-by-side render.
- **Review-like-a-PR** (diffs front and center) and **Plan Mode** (strategize before execution). →
  Verifiable Landing / Gates is our PR-review equivalent; `intake`/architect is Plan Mode.
- **One-click "bring this worktree to the foreground"** and **Canvases** (live dashboards over scrolling
  logs). → worktree seam already exists; Canvases map to the Pillar 3 trace tree.

**Where we plant one level above Cursor (the differentiation):**
- Cursor's Agents Window is *a single engineer with helpers*: the loop runs in Cursor's cloud, it is
  single-operator, and config is settings panels + Rules files. Our bet is the **manager of a team**: the
  roster IS the team, config is a **conversation** (decision #1), it is **local-first** (your compute, your
  weights), **multi-operator**, and **open** (decision #3). Cursor is the GitHub-shaped product; we are the
  git-shaped protocol underneath the category.
- The manager's day, concretely: *glance* at the board → *be-asked* only on typed exceptions → *review*
  diffs as PRs gated by verification → *talk to the control-tower LLM* to redirect the fleet. No file tree
  as the primary surface. No form-filling. Human-on-exception, not human-in-the-loop.


### Civilizational Management Primitives \u2014 The King's Tools (Applied Forward)
The Manager-grade IDE is not a new UI; it is the digital restoration of the command-and-control doctrines that built empires. We abstract the tools of the King, the General, and the Merchant into the agentic fleet.

1. **The Hill (The General\u2019s Visualizer):** The Manager stands on the hill; they do not stand in the trench. The \"Glance\" board must render the *movement of units* (agent state, intent-density, heat maps) rather than a wall of logs. If you have to read the log to know the status, the Hill is too low.
2. **The Yam (The High-Bandwidth Spine):** Named for the Mongol post-system. The event spine ensures that even when agents run on \"remote frontiers\" (cloud/SSH/local-weights), the message latency is predictable and the status is immutable. The Yam is the protocol that keeps a distributed fleet coherent.
3. **The Ledger (Double-Entry Provenance):** Adopted from 13th-century Florentine bankers. Every code edit is a transaction. The \"balance\" is the verification gate (tests/lints). If the ledger doesn't balance, the landing is rejected. Verifiable landing is the modern Tally Stick.
4. **Auftragstaktik (The Doctrine of Intent):** The Prussian \"mission-type tactics.\" The Manager speaks in *Intent* (\"Refactor the Auth layer for OIDC support\") and *End States*. The agents use *Disciplined Initiative* to execute the \"how.\" The IDE surface is the interface for Intent, not for Code.
6. **Standardized Weights & Measures (The Merchant's Trust):** In trade, the King standardized the weight of a coin to enable trust. We standardize the *Evaluation Gate* (Scorers/Evals) and the *Verification Gate* (Property Testing/formal checks). Trust in the fleet's output is not subjective; it is measured against the standard.
7. **The Fortification (The Siege-Proof Host):** The Castle protected the population. `mt-isolation` and the resource watchdog protect the host. Multi-tenancy is not just an enterprise feature; it is the structural defense of the manager's compute sovereignty.

`ponytail:` this section is strategy that now *gates* plans, not a plan itself. It commits no new mechanism.
The next conversion step is a `/plan` for the manager-grade board + conversational-config surface, built on
the existing `intake`/`smart-spawn`/`applyCommand`/event-spine seams — not a new UI stack.
