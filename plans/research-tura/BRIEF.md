# Research Brief: Tura AI

## Provenance

- **Date**: 2026-07-27
- **Question**: Why does Tura win — adoption, daily usage, what its practice knows that glance's doesn't — with special attention to its verified-change loop and auditable benchmarks (analog-default question; bare-URL invocation).
- **Target project**: omp-squad (glance) — agent-fleet daemon + web cockpit; bottleneck on record: daily-driver adoption/trust ("foundation-loved before features", north star).
- **Sources**:
  - https://turaai.net/llms.txt and https://turaai.net/llms-full.txt (fetched live; /benchmark and /blog pages are client-rendered SPAs — content sourced from their GitHub-hosted markdown backing, per the site's own llms.txt)
  - github.com/Tura-AI/tura — default branch `main`, HEAD **`09b7913a693e82c6ebd4ffea0081ab063dd03316`**, inspected 2026-07-27 (repo created 2026-07-06, last push 2026-07-27)
  - npm `tura-ai` **0.1.34** (published 2026-07-24); downloads via api.npmjs.org
  - github.com/Tura-AI/benchmark (README + doc/current-test-set-record.md; raw manifests referenced, not independently re-run)
  - JetBrains blog: blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/ (independent corroboration of the token-saving-plugin teardown)
- **License of researched code**: AGPL-3.0-or-later — pattern-borrowing only; code adoption is license-poisonous for this repo.
- **Answer to the question, in one line**: Tura does *not* win (474 stars, ~4.3k monthly npm downloads, zero organic discussion three weeks post-launch) — its value to glance is code-verified architecture patterns plus a measurement discipline, and a candid founder post-mortem on why rigor anti-correlates with adoption in this niche.

---

## Scout brief — artifact axis (how it's built)

**What it is**: a local, open-source coding agent (CLI/TUI/GUI) marketing reduced LLM round trips via macro tool-calling, explicit runtime-modeled task state instead of prose memory, and benchmark evidence over demos. BYOK — no bundled model access.

**Architecture**: Rust workspace, multi-process, one isolated backend per `TURA_HOME`: `tura_session_db` (sole SQLite owner, socket IPC — no shared file access), `tura_router` (dispatch/registry/supervision daemon), `tura_runtime` (per-session worker, spawned-and-dies), `gateway` (axum HTTP/SSE), thin CLI. Fronts never touch the session DB; everything routes through the router. Multi-agent = runtime spawning `tura_router run-agent` subprocesses (stdin/stdout JSON, deliberately never HTTP) to keep dispatch single-directional. That discipline is enforced by an actual test: `crates/lifecycle/tests/service_dependency_architecture.rs`. GUI is SolidJS + Tauri 2; TUI is TypeScript over gateway SSE.

**Round-trip reduction (code-verified, not marketing)**:
- `command_run` (`crates/tools/src/command_run/{handler.rs,schema.json}`) is the *single* model-visible tool. Schema **requires 5–20 commands per call**; each carries a `step` (dependency group, not serial index). Runtime executes same-step read-only commands concurrently, steps in ascending order, mutating commands (e.g. `apply_patch`) always exclusive under workspace file locks. Their stated rationale: "Models are bad at [scheduling]; the runtime is less impressionable" (`docs/core/command-run.md`).
- **Compaction without a summarizer call**: the agent emits `task_status.compact_context` inside an existing batch; runtime (`crates/runtime/src/context/compaction.rs`) converts it into a structured `context_compaction` session-log record (goal, workspace snapshot, environment context, retained tool tail). Provider messages are **rebuilt from structured records** (`crates/runtime/src/context/build.rs`), never replayed as a flat transcript. Default limit 260k tokens; compaction targets ~1/10.
- **Runtime Prompt manuals**: task-specific instruction bundles (`frontend`, `debug`, `devops`) loaded only when `task_status.task_type` selects them — reduces steady-state prompt size vs pasting all skills into every prompt.
- Self-acknowledged caveat (their own `docs/KNOWN_ISSUES.md`): no ablation proving `command_run` alone causes the lower token usage.
- README's "backward reasoning" claim: no code path located — LOW-CONFIDENCE, marketing prose only.

**Explicit execution state**: `SessionManagement` (defined once in `crates/lifecycle`, consumed by all services) holds task_type/task_plan/capabilities/log/tokens/usage. State is written only via the dedicated `task_status` tool (`status`: doing/question/done, `task_group`, `task_type`, optional `compact_context`), applied post-hoc by the runtime — never inferred from chat prose.

**"Verified repository changes" — weaker than the tagline**: `status=done` is gated by *prompt wording only* ("after required verification… don't mark done if checks failed, timed out, were skipped, or could not start"). A `ValidatorConfig` (`need_validator`, `validator_name`) exists in the data model, but **every shipped agent sets `need_validator: false`** — the independent-validator gate is an extension point, not a shipped feature. The benchmark "verifier success rate" comes from the external DeepSWE harness, not the product. Who decides a change is good = the coding agent itself. Sandbox (`TURA_COMMAND_RUN_SANDBOX=1`) is opt-in, off by default.

**Stack**: Rust (axum, tokio, rusqlite bundled, reqwest), Tauri 2 + SolidJS GUI, TS TUI, bun-driven npm packaging with per-platform binaries. Default flagship agent `balanced` pins `current_model: codex/gpt-5.6-sol`.

**Not inspected**: `Tura-AI/benchmark` internals beyond README/records doc; `crates/provider` per-provider protocol code; Tauri shell.

---

## Scout brief — practice axis (how it's used and why it wins/loses)

**Who builds it**: one person. Yohjisakamoto = 83% of counted contributions; the 19-commit main history is explicitly squashed from several hundred ("squash: 85 contiguous commits by Yohji"). npm maintainer matches. Solo pivot from a dead e-commerce-chatbot startup whose state-machine/deterministic-execution architecture he repurposed (his own account, Discussion #23, 2026-07-25). Org created 2026-02-02; public launch 2026-07-16.

**Dogfooding**: real. Founder reproduces user bugs in matching environments (rebuilt a reporter's exact WSL2/devcontainer for issue #5), answers architecture questions at implementation depth, and authored `docs/KNOWN_ISSUES.md` — a public list of his *own* unproven claims and architecture debt. Heaviest-churn subsystems = TUI rendering/scrollback, provider routing, npm packaging — consistent with a terminal-first self-hosted daily driver. npm publish breakage was fixed same-day, three commits in hours (pain felt personally); multi-provider matrices and cross-OS baselines linger, flagged rather than fixed (off the dogfood path).

**Community**: near-zero organic traction. 474 stars / 22 forks at 3 weeks post-launch; 4,342 npm downloads last month, 845 last week. No HN submission, no Reddit thread found. 4 open / 1 closed issues. PRs: 14 closed, only 5 merged; 5 bulk PRs from one outside account filed in a 20-minute window were closed with zero engagement. Genuine outside merges exist (session-DB fix, Mistral routing, TUI autocomplete) and got reviewed within days. Founder response latency on issues: hours to ~2 days, with live reproduction attempts.

**Benchmark story** — the strongest practice artifact:
- Compared: Tura Balanced/Direct (GPT-5.6 SOL, high reasoning) vs Codex CLI medium (instrumented build) and high (official 0.144.1 unmodified). 20-task DeepSWE v1.1 × 60 sessions/config (280 published runs) + a 5-task Rust→Python rewrite benchmark scored against 472 harness assertions.
- Headline (self-reported): DeepSWE 48/60 (80.0%) vs Codex High 36/60 (60.0%); Direct −77.5–83.5% tokens vs Codex High. Their own publications disagree internally (16.7pp in the org bio vs "20 percentage points" in the blog for the same comparison).
- **Auditability mechanics**: raw run artifacts published as canonical manifests (`results/debug/`, `results/rewrite/`), a documented `excluded-runs.csv` naming each removed outlier and why, a re-runnable Docker pipeline pinned to a task-set revision, and a statistical write-up that separates descriptive association from causal claims and flags its own confounds unprompted.
- **Limit**: entirely self-graded — no third-party run, no leaderboard, no external reproduction found. The founder flags this himself in KNOWN_ISSUES.md before any critic does. The "up to 83.1% fewer turns" repo bio is best-case framing sitting on top of otherwise rigorous data.

**The token-saving-plugins teardown** (blog: "Token-Saving Plugins Are Mostly Stupid Idea", July 2026): ran their rewrite benchmark against RTK and Ponytail. Claimed 60–90% per-call savings evaporate at whole-task scope: **RTK measured +7.18% MORE expensive end-to-end**; Ponytail −8.87% but inside a **51.69% run-to-run variance band**. Independently corroborated the same week by JetBrains (RTK; and a separate JetBrains post found Caveman's claimed 65% savings measured at 8.5%). Meanwhile Caveman has ~24.9k stars — ~50× Tura — which is the founder's post-mortem in one number: simple exaggerated claims spread; rigorous harnesses don't. A commenter's structural addendum: Tura is "a harness, not a plugin or skill" — harnesses have inherently worse viral mechanics.

**Defaults as frozen opinions**: BYOK, no privileged provider; TUI opens safely with zero config; one macro tool as the central architectural bet; sandbox opt-in (permissive by default); test-running left to the agent's judgment.

---

## Strategist — ranked transferable concepts

Comparator round skipped per skill (single target); concept extraction folded into this pass. Ranked against the named bottleneck: **daily-driver adoption/trust — "foundation-loved before features"** (north star; recurring trust pain on record: stale running claims, signal kinds that never fired, absence-as-answer review rounds, self-graded green gates).

**Build vs Buy, globally**: borrow patterns only. Tura is AGPL-3.0 (license-poisonous to this repo), three weeks old, single-founder, and solves no hard problem glance lacks. Nothing here justifies a dependency.

### 1. Whole-task cost is the only honest efficiency metric

**Pattern**: never accept or report per-call token savings; measure end-to-end task cost (tokens + wall-clock + pass/fail) across repeated runs, report the run-to-run variance band alongside the mean, publish raw per-run manifests plus a documented exclusion list naming every dropped outlier and why.
**Mechanism**: a fixed task set × N sessions per config; canonical per-run artifacts committed to the repo; `excluded-runs.csv` with reasons; a write-up that separates descriptive association from causal claims.
**Value for glance**: glance already ingests per-harness cost (`src/ingest/claude-code.ts`, `src/ingest/codex.ts`, `src/ingest/openrouter.ts`) and aggregates it (`src/cost-aggregate.ts`, `src/cost-gate.ts`, `src/attribution-scoreboard.ts`) — but every efficiency claim glance makes about itself (noisegate's signal-ranked reduction in `src/output-reduce.ts`, model-routing choices) is per-call-shaped, exactly the metric class two independent measurements just showed can invert at whole-task scope (RTK: 60–90% claimed, +7.18% measured).
**Immediate corollary**: this repo *uses RTK* (auto-memory: "rtk mangles grep output"). Two independent measurements (Tura's harness, JetBrains) now say RTK is net-negative on whole-task cost, on top of the correctness problems already on record. Measuring-then-removing rtk is a same-day win.
**Where it applies**: a small benchmark lane over the existing gate infrastructure (`src/gate-runner.ts`) driving repeat runs of a pinned task set per fleet config; manifests written next to `src/land-assessment/` conventions (it already has `manifest.ts`/`projection.ts`/`replay/`).
**Build vs Buy**: build — it's a thin loop over infrastructure glance already owns.

### 2. State transitions are tool calls, not prose

**Pattern**: the agent declares lifecycle transitions (doing / question / done, plus task class) through a dedicated structured tool; the runtime applies them post-hoc to one canonical session-state record defined in exactly one place; every consumer (UI, roster, dispatch) reads only that record.
**Mechanism**: Tura's `task_status` tool → `apply_tool_result_session_state_update` → `SessionManagement` (single definition in `crates/lifecycle`, consumed by all services). "done" carries required-verification semantics in the tool's contract.
**Value for glance**: glance's worst recurring trust bugs are exactly prose-vs-state splits — stale "running" claims from roster/transcript divergence (fixed once in PR #216, pattern recurred), signal kinds that never fired for five waves (boot-the-room), absence-as-answer rounds. A single-definition session-state record with tool-driven transitions makes "what is this unit doing" a fact, not an inference over transcript deltas.
**Where it applies**: `src/agent-lifecycle.ts`, `src/sessions.ts`, `src/transcript-event-kinds.ts`, `src/dispatch.ts`. Full injection works for omp-native units; for foreign harnesses behind the AgentDriver seam (`src/agent-driver.ts`, `src/acp-agent-driver.ts`) the transition vocabulary maps onto ACP/protocol events rather than an injected tool — partial but still unifying.
**Build vs Buy**: build (borrow the shape only).

### 3. Compaction as a structured checkpoint the agent emits in-band

**Pattern**: no separate summarizer call — the agent emits a typed checkpoint (goal, workspace snapshot, environment, retained tool tail) as part of a normal turn; the context sent to the provider is *rebuilt from typed records*, never a replayed flat transcript.
**Mechanism**: `context/compaction.rs` + `context/build.rs`: checkpoint record kinds in the session log; deterministic rebuild; compaction to ~1/10 of the context limit.
**Value for glance**: direct evidence-from-a-shipping-system for the in-flight `plans/research-long-horizon-agent-memory` work (EXPERIMENTS/VALIDATION/REDTEAM docs active right now) — it operationalizes "structured checkpoint beats prose summary" and "rebuild beats replay", and it composes with noisegate (`src/output-reduce.ts`): noisegate ranks what survives; the checkpoint types what survives *as*.
**Where it applies**: `plans/research-long-horizon-agent-memory/` (cite as related work + a design datum), then whatever memory substrate that plan lands.
**Build vs Buy**: build; fold into the existing research rather than a new plan.

### 4. A standing unproven-claims ledger (KNOWN_ISSUES as self-audit)

**Pattern**: the maintainer publishes, in-repo, a ranked list of the project's *own* unproven claims and architecture debt — "we say X but have not measured it" — updated as claims are proven or die.
**Mechanism**: Tura's `docs/KNOWN_ISSUES.md`: benchmark coverage gaps, missing ablations, coupled contracts — flagged by the author before any critic.
**Value for glance**: honesty-as-architecture is already glance's meta-pattern, but it's enforced episodically (/reality-audit, blind review) rather than as a standing artifact. A `KNOWN-UNPROVEN.md` gives Lars's comprehension lane a persistent "here is what we assert but haven't proven" surface — the exact opposite of the "plans lie" failure class, and near-zero cost.
**Where it applies**: repo root or `plans/`; seeded from the last reality-audit's residue; the /reality-audit skill appends to it instead of only emitting point-in-time reports.
**Build vs Buy**: build (it's one markdown file plus a habit).

### 5. Runtime-side scheduling of model-declared command batches

**Pattern**: one macro tool whose schema *requires* a batch (Tura: 5–20 commands) with per-item dependency groups; the runtime schedules — same-group read-only ops run concurrently, mutating ops exclusive under file locks. The model declares intent and ordering constraints; the runtime, "less impressionable," owns execution.
**Value for glance**: glance doesn't own foreign harnesses' inner tool loops, so the headline round-trip savings mostly aren't glance's to take. It applies where glance calls models itself (`glance ask`, primer, learning-loop analyses) and to any future omp-native harness lane. Real but off-bottleneck.
**Where it applies**: glance-owned model-call sites; a design note for any native-harness work.
**Build vs Buy**: build, later; do not adopt (AGPL).

### 6. Topology invariants as executable tests

**Pattern**: encode process-topology rules — who may spawn whom, who owns the DB, which direction dispatch flows — as a unit test that fails when a dependency edge violates the architecture.
**Mechanism**: `crates/lifecycle/tests/service_dependency_architecture.rs`; complemented by single-owner DB access over socket IPC (no shared file access between processes).
**Value for glance**: the registry friendly-fire reap (two components each believing they owned host lifecycle, every chat dying in under a minute) is precisely the defect class such a test catches at commit time instead of live. Cheap and durable.
**Where it applies**: a test over the daemon/registry/factory ownership rules (registry vs root factory lifecycle authority, driver spawn direction) alongside the existing suite.
**Build vs Buy**: build.

### 7. Practice anti-lessons (intel only — no action)

- **Rigor anti-correlates with virality in this niche**: Caveman, with an 8×-overstated savings claim, has ~50× Tura's stars. Glance's n=1, dogfood-first, foundation-loved strategy is not a marketing failure — it's the correct posture for a harness, confirmed from the outside by a founder who tried the alternative and post-mortemed it publicly.
- **"Verified changes" as tagline vs shipped gate**: Tura's validator is scaffolded but disabled in every shipped agent; verification is prompt discipline. Glance's layered land interlocks are *ahead* of the analog here — this is a keep-investing signal, not a gap.
- **A squashed-history solo repo with 83% single-author contributions and bulk drive-by PRs closed unengaged** is what "no community" looks like from the inside; glance should never mistake star counts or PR counts for the adoption signal that matters (Lars's daily use).

---

## Recommendation

Intel is actionable but small-grained — no single big /plan emerges. Highest-value next steps in order: (1) measure-then-remove RTK and stand up the whole-task cost lane (concept 1); (2) fold the structured-checkpoint evidence into research-long-horizon-agent-memory (concept 3, zero new scope); (3) KNOWN-UNPROVEN.md (concept 4, one file); (4) session-state unification (concept 2) as a real concern worth a /plan slot when lifecycle-truth work next opens. Concepts 5–6 are design notes for existing lanes.
