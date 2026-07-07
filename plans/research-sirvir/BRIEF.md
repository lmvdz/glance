# Research Brief: SouthpawIN/sirvir → glance (omp-squad)

**Date:** 2026-07-07
**Target project:** glance (omp-squad) — meta-harness running autonomous coding fleets in isolated git worktrees behind a harness-agnostic daemon.
**Source:** https://github.com/SouthpawIN/sirvir

---

## Phase 1 — Scout brief

**What it is:** A Hermes Agent *profile* (persona + skill bundle) for Nous Research's Hermes Agent framework that acts as an autonomous model-fleet manager — it serves, benchmarks, scales, and cost-tracks local + API LLMs for a multi-agent fleet. Not a standalone app; it's config + prompt + shell/Python tooling an LLM agent reads and executes.

**Problem it solves:** Running a personal/local multi-agent LLM setup means constantly juggling which GGUF model on which GPU, when to fall back to a paid/free API, avoiding OOM under VRAM pressure, which backend (llama.cpp/vLLM/Ollama/SGlang) is fastest per model, whether new HF releases are upgrades, and whether monthly spend is on budget. Sirvir centralizes all of it into one agent persona + one CLI.

**Architecture / components:**
- `SOUL.md` (16.8KB persona) + `AGENTS.md` (30KB ops doc) — always-loaded identity + hard behavioral rules.
- `skills/turbofit/scripts/serve` — a **2,532-line bash script** that is effectively the whole runtime: catalog bootstrap, alias resolution, `launch_server()` (nohup-detached llama/ollama/vllm/sglang processes tracked via flat pid/port files, health-polled 120s), `probe_vram()` (nvidia-smi → JSON), `serve_auto()` (VRAM-threshold brain that picks curated-local vs API and wires it into Hermes `config.yaml`), `serve_downscale()` (degradation ladder), systemd "wake-on-ping" daemon mgmt, `manage_mmproj()` (vision projector), `bench_model()` (lm-eval-harness).
- `skills/sirvir/scripts/model_router.py` (41KB) — reads Hermes `state.db` (SQLite) per-profile across 24h/7d/30d windows, classifies each profile into a usage tier (light/moderate/heavy/corp), scores candidate providers/models against **task-type keyword buckets** (financial/creative/coding/operations/quick/reasoning) using **priority-weighted latency/quality/cost formulas** (e.g. `speed: {latency:0.60, quality:0.25, cost:0.15}`). Gates NVIDIA-NIM free lanes by governing tier.
- `skills/sirvir-budget/scripts/audit_fleet.py` — same state.db aggregation fleet-wide → prints spend / cache-hit summaries across all profiles.
- `sirvir-bench` / `sirvir-scale` / `sirvir-serve` / `sirvir-research` — on-demand skills split out of the turbofit monolith for context-window economy.

**Key design decisions:** bash hot-path + Python analytics; detached OS processes tracked by flat files (not containers); a strict non-negotiable optimization ladder (262K ctx → 30 tok/s → 1M ctx → max speed) hard-coded into the persona; free-API-first cost policy (local → free NIM → paid, routed through Nous Portal for a 10% bonus); "never kill mid-response" guardrail; skill decomposition retrofitted for per-turn token economy.

**Open self-identified debt (issue #2):** SOUL.md (~3,400 tok) + AGENTS.md (~6,100 tok) = ~9,500 tokens of **always-loaded overhead per agent turn** (~285K over a 30-step task). Proposal: strip SOUL.md to ~150 words, push ops detail to on-demand skills, measure the per-turn prompt tax.

**Tech stack:** Python + Shell only. Depends on separate `turbofit` repo. Host = Hermes Agent ≥0.12.0 (installed via `hermes profile install`). Backends: llama.cpp/vLLM/Ollama/SGlang. Providers: NVIDIA NIM (free), Nous Portal (paid primary), OpenRouter (secondary), HuggingFace. Storage: flat YAML catalogs + Hermes state.db (read-only for analytics) + JSON reference files.

**Maturity:** 18★, 3 forks, created 2026-06-26, last push 2026-07-02 (~1 week active then quiet), ~22 commits / 2 contributors, 1 branch, 0 PRs, 1 self-filed issue. **No tests, no CI, no LICENSE file.** A working in-use personal/small-team tool with real logic (VRAM probing, process lifecycle, SQLite usage queries), not a vision doc — but early-stage and single-maintainer.

---

## Phase 2a — Comparator (concept → implementation → transferable?)

| Concept | How sirvir implements it | Transferable to glance? | Why / why not |
|---|---|---|---|
| **Usage-driven, task-class-aware model routing** | `model_router.py` reads measured per-profile usage from state.db, buckets task type by keywords, scores models with priority-weighted latency/quality/cost, picks. | **Yes — highest value** | glance already ships per-harness cost ingesters ($36.77 real gpt-5.5 surfaced, #70) but only *reports*. It never routes future units on measured cost/quality. This closes glance's OPEN "task-class×model scoreboard" item and turns attribution into a decision. |
| **Fleet-wide spend/cache audit as one surface** | `audit_fleet.py` aggregates state.db across all profiles → spend + cache-hit per profile. | **Yes** | glance has attribution ingesters but the aggregate scoreboard is unbuilt. A single `glance spend` command/panel grouping cost by task-class×model×harness is a direct fill. |
| **Harness-prompt token budgeting** (issue #2) | Measures always-loaded SOUL+AGENTS overhead per turn; refactors to load-on-demand skills; targets the recurring tax. | **Yes** | glance ships MCP-per-profile + a skills axis + a profile catalog + CLAUDE.md — all a recurring per-step prompt tax that is currently *unmeasured*. Instrument per-profile prompt overhead; make the catalog load-on-demand. |
| **Ordered degradation ladder under resource pressure** | `serve_downscale()` walks shrink-ctx → drop-aux → smaller-tier → CPU-offload rather than hard-failing on VRAM pressure. | **Partial (abstract it)** | glance runs on API harnesses, not local GPUs — the VRAM specifics don't port. But the *pattern* — a defined ordered fallback ladder when a unit hits a rate limit / budget cap / context overflow, instead of hard-fail — does. |
| **Free-first provider preference + free-lane gating by tier** | Prefers local → free NIM → paid; gates free lanes by governing usage tier; routes paid through a portal for a bonus. | **Partial** | glance's model policy is ranked by taste/intelligence/cost (fable/opus/sonnet), not a cost-tier fallback ladder. "Gate the cheap lane by measured tier, escalate only when the cheap lane underperforms" is a borrowable selection discipline. |
| **Persona-as-hard-policy** | Non-negotiable rules ("never kill mid-response", optimization floors) encoded in the SOUL.md prompt. | **Partial (contrast)** | glance deliberately prefers **policy-as-data, tighten-only** (from omnigent research). Sirvir's prompt-encoded policy is the *anti-pattern* glance already rejected — useful as a confirming contrast, not an adoption. |
| **Skill decomposition for context economy** | Retrofitted monolith → per-skill on-demand loading. | **Yes-ish (already converging)** | glance already does MCP-per-profile (agent-profiles PR #92). The recurring lesson — load only the capability the step needs — reinforces the existing direction. |
| **Multi-sink consolidated event logging** | Fans HF scans / benches / swaps / budget alerts to Discord + blog + GitHub. | **No** | glance already has a harness-agnostic attention lane + notify. Not novel. |
| **Wake-on-ping daemon** (backend starts on first request, frees VRAM on stop) | systemd units keep proxy up, spawn backend lazily. | **No** | glance has no local GPU/model-serving process to lazily spawn. Not applicable. |

**Cross-reference:** sirvir is a **third independent convergence** on "measure per-unit model cost/quality and route on it" — echoing glance's own `harness-attribution` memory (per-harness ingesters DONE, task-class×model scoreboard OPEN) and `model-policy` memory. Same signal as the meta-harness-convergence theme across the omnigent/GOOP/Mastra research.

---

## Phase 2b — Strategist (ranked, mapped to glance) — opus, adversarial

**The comparator's ranking inverts once you inspect glance's real code. glance has already built most of the top concepts — but the #1 borrow is a live no-op because of a verified dead wire.**

### What glance already has (verified in worktree)
- `src/attribution-scoreboard.ts` — `buildScoreboard()` joins the model-outcome ledger with cost receipts → per-model land-rate overall + `byTier` (light/mid/heavy) + `costPerLandedChange` + `harnessSpend`.
- `src/model-outcomes.ts` — `${model}::${tier}` → `{landed, rejected}` ledger; `tierOf(thinking)` buckets thinking level into the task-class axis. Recorded always-on at `src/squad-manager.ts:2494`.
- `src/smart-spawn.ts:58` `shiftedModel()` — outcome-driven model default: reads land-rate per `(model,tier)`, shifts default toward the proven winner, floored by `MIN_SAMPLES=8` / `MIN_EDGE=0.15`, gated on `OMP_SQUAD_MODEL_OUTCOMES=1`.
- `src/cost-gate.ts` — `projectCost()`/`shadowCostCheck()` projects `$/landed-change` BEFORE spawn; **WARN-only (shadow), never routes**. Wired at `squad-manager.ts:142`.
- `src/rate-limit.ts` `RateLimitGate` — pauses dispatch on a usage cap; consumed in `src/dispatch.ts:160-172`.
- `src/workflow/stylesheet.ts` — declared (author-written) per-node model routing.
- Surface: `/api/graph/scoreboard` + `/api/graph/attribution` (`src/server.ts:1998,2013`), `webapp/src/components/ScoreboardPanel.tsx`.

### Ranked borrows

**#1 — Close the attribution → routing loop (the router exists but is a live no-op). HIGHEST ROI.**
- **Pattern:** Measured per-unit outcomes should *decide* the next unit's model, not just be reported. Score `(candidate model, task-class)` on a priority-weighted blend of land-rate AND cost, pick above a confidence floor, fall back to heuristic when samples are thin.
- **Two verified gaps make glance's router inert:**
  - **Dead wire (adversarial finding):** `src/server.ts:1376` calls `planSpawn(prompt, { cwd, candidates })` and **never passes `outcomes`**. Inside `shiftedModel` (`smart-spawn.ts:60`), `if (... || !outcomes) return {}` fires first — so even with `OMP_SQUAD_MODEL_OUTCOMES=1` set, the live smart-spawn path does **zero** shifting. Unit-tested but disconnected from production. ~3-line fix to inject a `readModelOutcomes`-backed reader.
  - **Under-powered scorer:** `shiftedModel` is boost-only over exactly two candidates (`["opus","default"]`, `smart-spawn.ts:36`) and scores on **land-rate alone** — it ignores cost, though `attribution-scoreboard.ts` already computes `costPerLandedChange` per model. The real transferable contribution is the *cost-weighted, multi-candidate* formula folding in the number the scoreboard already produces.
- **Where:** `src/smart-spawn.ts:58-75` (scorer), `src/server.ts:1376` (dead wire), and higher-leverage `src/workflow/stylesheet.ts` (the seam where a measured router could *compute* the class→model assignment the author currently hand-declares). `src/cost-gate.ts` already has the projection half.
- **Build vs Buy:** Borrow the formula. Substrate is native. Mostly reconnection, not construction.

**#2 — Graceful degradation ladder (glance has one rung of five). Best genuinely-greenfield item.**
- **Pattern:** On resource pressure (rate-limit / budget cap / context overflow), walk an ordered fallback ladder — smaller model → different lane → shorter context → defer — instead of hard-failing or stalling the whole fleet.
- **Verified gap:** `RateLimitGate` implements exactly **one** rung — "defer" — and it pauses the *entire fleet's dispatch* (`dispatch.ts:160`), not just the capped unit. For a meta-harness whose thesis is running units on any of omp/pi/claude-code/codex/opencode/gemini behind `src/harness-registry.ts`, the natural move is **lane-switching**: a unit that hits Anthropic's 5h cap re-dispatches onto a codex/gemini lane instead of freezing the fleet. glance uniquely has the harness seam to make this cheap; genuinely unbuilt.
- **Where:** `src/rate-limit.ts` (binary pause → ladder), `src/dispatch.ts:113-172` (per-unit re-route vs global pause), `src/harness-registry.ts` (lane inventory). Connects to #1's scorer for "which cheaper lane."
- **Build vs Buy:** Borrow. Small ordered-list state machine; lanes already registered.

**#3 — Fleet spend/cache scoreboard — MOSTLY DONE, downgrade hard.**
- `buildScoreboard()` already produces per-model land-rate `byTier` + `costPerLandedChange` + `harnessSpend`, served at two endpoints, rendered in `ScoreboardPanel.tsx`. Residual gaps are marginal polish: task-class axis is thinking-tier not keyword task-type; no single 3-way `task-class × model × harness` cube; **no `glance spend` CLI** (webapp-only — a plausible small add for headless/loop use); no cache-hit column (glance receipts likely lack cache metadata for external harnesses).
- **Build vs Buy:** Borrow only the CLI-surface idea; the aggregation is done. Do not rebuild.

**#4 — Free-lane gating by measured tier — near-duplicate of #1, fold in.**
- This *is* the shape of `shiftedModel` already. Its one distinct nuance — *default cheap, escalate on measured underperformance* (vs glance's current "opus for hard work, omit otherwise" heuristic) — is a policy tweak best folded into #1's scorer as a cost-weight that biases toward the cheap lane until land-rate evidence overrides. Not a separate build.

**#5 — Per-turn harness-prompt token tax — unmeasured but low-actionability, lowest priority.**
- Premise confirmed (grep finds no per-turn prompt accounting). But low-value for glance: it dispatches onto **external** harnesses whose system-prompt overhead it neither owns nor can decompose; receipts (`src/receipts.ts`) are per-*run* cost, not per-turn prompt breakdowns. And the proposed remedy — load capabilities on demand — is **already glance's design** (MCP-per-profile, `src/agent-profiles.ts`, shipped PR #92). Only novel residual is *measuring* the tax, which glance can't cleanly obtain from third-party harnesses. Borrow the awareness only; don't build measurement infra against data glance doesn't receive.

### Bottom line
Concept **#1 is the prize precisely because it's 70% built and silently disconnected** — fix = reconnect (inject the outcomes reader at `server.ts:1376`) + a cost-weighted multi-candidate scorer using `costPerLandedChange` the scoreboard already computes. Concept **#2 (degradation ladder)** is the best greenfield item; glance's harness-registry makes lane-switching its natural form. Concepts **#3/#4/#5 are substantially already shipped or low-actionability** — marginal at most.
