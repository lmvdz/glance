# Research brief: omnigent (omnigent-ai/omnigent) → glance

**Date:** 2026-07-07
**Target project:** glance (omp-squad) — TS/Bun autonomous agent-fleet factory
**Researched:** https://github.com/omnigent-ai/omnigent
**Pipeline:** SCOUT (sonnet) → COMPARATOR (sonnet) → STRATEGIST (opus; fable limit hit) → this brief

---

## Headline

omnigent is a **Databricks-authored Python "meta-harness"** (6.5k★, Apache-2.0, created 2026-06-11, **alpha**, ~weekly releases, PRs past #2094) that runs *other* coding-agent CLIs/SDKs — Claude Code, Codex, Cursor, OpenCode, Hermes, Pi, Kiro, Qwen, Kimi, Copilot, Google Antigravity/Gemini — under one unified session, policy, and UI model.

It is, in one line, **a well-resourced independent implementation of the same core bet glance already made**: harness diversity is permanent, so the value is the governance/orchestration layer *above* the vendor CLIs. That convergence is the primary signal — it validates glance's `AgentDriver`/harness-registry direction. The *actionable* intel is the handful of places omnigent went **further** than glance.

---

## Phase 1 — SCOUT (facts)

**What it is.** A meta-harness: orchestration + runtime + policy + multi-surface UI over vendor coding agents. Authored by "Databricks, Inc." (per `pyproject.toml`) under a neutral org name; ships first-class Databricks Apps deployment but supports API keys / OpenRouter / LiteLLM / Ollama / vLLM / Azure as first-class too.

**Problem.** Multiple AI coding agents = siloed, single-device, ungoverned sessions; no common interface, no cross-device continuity, no spend/tool controls, no cross-vendor review.

**Architecture (concrete modules):**
- `omnigent/spec/` — agents are declarative **YAML**: `prompt`/`instructions`, `executor` (harness+model+auth), `tools` (function/MCP/sub-agent), `policies`, `os_env`, `terminals`. Parser + validator + types. "Agents can author agents" since a spec is just YAML.
- `omnigent/runtime/` — turn execution. `harnesses/` per-harness adapters; `policies/` (engine/enforcement/approval/builder); `compaction.py` (context overflow); `credentials/`.
- `omnigent/runner/` — per-session process: app, tool_dispatch, mcp_manager/proxy_mcp_manager, policy, pending_approvals, and `transports/` = TCP + Unix sockets + custom **WebSocket tunnel** (ws_tunnel) so a runner can live on a remote/sandboxed host while server/UI live elsewhere.
- **Per-harness "native" modules** (claude_native, codex_native, cursor_native, opencode_native, …) — each with bridge/forwarder/hook/state/permissions submodules. These **PTY-wrap or RPC-drive the actual vendor CLI** (via pexpect/pyte terminal emulation) and translate its native transcript/tool-call format into a common event stream, **reflecting the vendor's own approval prompts into omnigent's policy/elicitation UI**. Contrast lighter `-sdk` harnesses. Native = human-exact parity; largest single chunk of the codebase.
- `omnigent/sandbox/` — OS isolation: bwrap.py (Linux bubblewrap), seatbelt.py (macOS), Windows Job Object fallback. Plus **pluggable cloud sandbox launchers** (Modal, Daytona, Islo, E2B, CoreWeave, K8s, NVIDIA OpenShell, Boxlite) — each **lazy-imported**, dependency-free in the base package until first use.
- `omnigent/policies/` — declarative gate system (base/function/registry/cel). Builtins: `ask_on_os_tools`, `max_tool_calls_per_session`, cost budgets, GitHub/Google-Drive scoping, **CEL-expression policies**, risk scoring, routing. Policies return **ALLOW/DENY/ASK** and stack at **three levels — session (first) → agent-spec → server-wide (last)**, any DENY short-circuits. Net effect: end users can only **tighten**, never loosen, what admins allowed. CEL chosen for a **formal safety property**: non-Turing-complete, guaranteed-terminating, side-effect-free; degrades gracefully if the package is absent.
- `omnigent/server/` — FastAPI + REST/WS, multi-tenant auth, OIDC SSO, sessions, hosts. **Policy REST API** to add/remove server-wide policies at runtime (no redeploy).
- `omnigent/host/` — a machine registers itself (`omnigent host`) so the server can dispatch new sessions there or to a managed cloud sandbox.
- Frontend `web/` — React+Vite+TS, xterm.js terminal, Monaco, **OpenTelemetry Web SDK browser tracing**. Plus web/ios + web/android native shells, VS Code extension, macOS desktop app (**OS notifications + dock badge**).
- Storage: SQLAlchemy+Alembic, SQLite/Postgres + Cloudflare D1 dialect; S3/R2/MinIO artifacts.

**Differentiator — the "Polly" example agent:** a **supervisor that writes no code**. It delegates coding to sub-agents from **different vendors** in parallel git worktrees, then **cross-reviews each diff with a reviewer from a *different* vendor than the author** — deliberate correlated-blind-spot mitigation. ("/debate" agent Debby is another example.)

**Process rigor.** `designs/CUJ-MAP.md` + `CUJ-ANALYSIS.md` track every Critical User Journey **and its failure branches** as a standing artifact. 1,421 test files, per-subsystem subtrees, `e2e_live` against a deployed app, Playwright visual-regression, per-model test pinning/rotation, a server/runner backwards-compat CI gate. `designs/harness-plugin-interface.md` defines a community plugin seam. The project is itself a **merger of two internal projects** (`designs/UNIFICATION.md`, legacy shims).

**Maturity.** Alpha badge, but unusually high velocity and test/design discipline for its age. Windows support explicitly degraded (no PTY native wrappers or bwrap/seatbelt there).

---

## Phase 2 — COMPARATOR (concept extraction)

| Concept | omnigent impl | Transferable to glance? | Why (delta over glance) |
|---|---|---|---|
| Meta-harness as permanent bet | Governance layer above harness diversity | Partial (reinforcing) | glance already made this bet (AgentDriver seam). Signal, not delta. |
| Native PTY-wrapping for human-parity | pexpect/pyte per harness; reflects vendor's own approval prompts | Partial | glance's seam is shallower (omp-rpc + ACP only); no native claude-code unit. |
| **Three-tier tighten-only policy stack** | session→agent-spec→server-wide, DENY-wins; users can only narrow | **Yes** | glance has no layered policy-as-data; trust is scalar (veto/confidence). |
| **CEL terminating expression language** | Non-Turing-complete, guaranteed-terminating inline policy | **Yes** | glance's gates are hand-written TS (regex arrays). |
| **Session-follows-you / fork a running convo** | Server-centric session state; attach/co-drive/**fork** | **Yes** | glance's Intervene View is a step-in *screen*, not a portable/forkable session object. |
| **Cross-vendor adversarial review** | Author + reviewer from *different* vendors | **Yes** | glance has the diversity but never spends it on blind-spot mitigation. |
| **Policy REST API (live mutation)** | Add/remove server-wide policies at runtime | **Yes** | glance's gate config is static/env-gated. |
| **Pre-execution cost/risk gates** | Budget/risk are policies that DENY/ASK *before* run | **Yes** | glance's cost is post-hoc observability only. |
| Pluggable cloud + OS sandbox breadth | bwrap/seatbelt/Job-Object + lazy cloud launchers | Partial | glance's gate-sandbox is one Docker path. |
| Host self-registration for dispatch | Machine registers → server dispatches there | Partial (reinforcing) | Adjacent to glance federation. |
| Full-stack OpenTelemetry (server+browser) | Distributed tracing incl. UI spans | Partial | glance has cost ingesters + spans, not browser+server distributed tracing. |
| CUJ-map + failure-branch discipline | Every journey + its failure branches as an artifact | Yes (process) | glance has plan docs/STATUS, no explicit journey×failure map. |
| Documented harness-plugin interface | Public contract for third-party harnesses | Yes | glance's registry is internal-only. |
| Multi-surface thin clients | VS Code / native macOS (dock badge) / iOS / Android | Partial | glance has web-push, not native OS integration. |
| Declarative one-YAML agent spec | prompt/executor/tools/policies/os_env/terminals in one file | Partial | glance units are imperative/code-configured. |

**Design tensions omnigent accepted:** native PTY parity vs maintenance load; CEL safety vs expressiveness; server-centric sessions vs attack/ops surface; sandbox pluggability vs integration tax; cross-vendor review vs ~2× cost; meta-harness vs upstream-CLI fragility (a vendor's breaking UI change becomes *your* incident).

**Recurring signal.** *Reinforces glance's bets:* harness-agnostic execution, sandboxed verification, step-in-from-anywhere, cost visibility. *Validates bets glance has NOT made:* layered tighten-only policy engine; adversarial cross-vendor review; formal terminating policy language; CUJ/failure-branch docs; native PTY parity.

---

## Phase 3 — STRATEGIST (ranked, path-verified against glance)

> Every glance path below was opened or grepped by the strategist. Key confirmed facts:
> `validatorModel()` in `src/validator.ts` defaults `"opus"` judging a `sonnet` executor (**same lineage** — concept 1's gap); `agent-guard.ts` policy is a **compile-time `FORBIDDEN_COMMANDS` regex array** + `protectedRoots` (concept 2's gap); `dispatch.ts` `budget` is **concurrency-only, no dollar gate** while `attribution-scoreboard.ts` is post-hoc (concept 3); `RuntimeSettingsStore` + `POST /api/settings/feature-flags` already provides the **runtime-mutation half** concept 2 reuses.

### 1. Cross-lineage adversarial review — spend the harness diversity glance already paid for
- **Pattern:** when one model both writes and judges a change, its blind spots are correlated. Force the reviewer to come from a *different model lineage/vendor* than the author — not merely a different process.
- **Mechanism:** at land time, read the executor's harness/model, select the validating judge from a **disjoint lineage**, and record the (author-lineage, reviewer-lineage) pair on the proof so a same-lineage review renders as weaker trust (as `sandboxed:false` already downgrades a proof).
- **Value:** glance's hands-off promise rests on a trustworthy land gate. Today the "independent" validator is independent in *tier + process* but not *vendor* (`validatorModel()` → `"opus"` judging `sonnet`). glance uniquely already runs a multi-vendor fleet, so this is nearly-free capability it isn't spending. Raises the ceiling on what lands unattended.
- **Where:** `src/validator.ts` (`validatorModel()`, `Judge`, `validatorGate` — the seam `landBranch` calls), `src/harness-registry.ts` (enumerates lineages+capabilities to pick a disjoint one), `src/convergence-oracle.ts`, `src/proof.ts` (stamping), surfaced via `src/confidence.ts` + `webapp/src/lib/agent-badges`.
- **Build vs Buy:** borrow. A few lines over the existing registry; no dependency.
- **Cost:** ~2× review spend on the reviewer call; a cross-vendor judge is only as good as its weakest harness — gate behind the registry `verified` flag so an unverified harness is never the sole reviewer.

### 2. Layered, tighten-only policy-as-data engine (folds in: terminating expression language + live policy REST)
- **Pattern:** governance decisions (may this tool run? may this land unattended? is this spend allowed?) are **data**, evaluated through three tiers that can only ever *narrow*: session/unit → agent-spec → server-wide (applied last). Any DENY short-circuits. Inline conditions in a small guaranteed-terminating side-effect-free expression form; the ruleset is mutable at runtime, no redeploy, degrading to defaults if the engine is absent.
- **Mechanism:** lift today's compile-time regex list into a rule table `{ scope, match, effect: allow|deny|ask, when?: <expr> }`; evaluate server-wide → agent-spec → session, DENY-wins; expose add/remove/toggle over the existing settings endpoint.
- **Value:** the single biggest structural gap on *both* north-star axes. Hands-off: "auto-answer low-risk" / "auto-land" are boolean flags + hand-written heuristics — a real policy stack lets glance safely auto-resolve *more* because the boundary is explicit and testable. Step-in: an operator tightens a misbehaving unit live (session-tier DENY) instead of killing it. glance already built the persistence+mutation half (`RuntimeSettingsStore` + `POST /api/settings/feature-flags`) — it just holds booleans.
- **Where:** `src/agent-guard.ts` (`screenToolCall`, `FORBIDDEN_COMMANDS`, `GuardContext.protectedRoots`), `src/lease-hook.ts` (in-process enforcement point), `src/authz.ts` + `src/agent-scope.ts` (existing scope logic to fold in), `src/runtime-settings.ts` (`RuntimeSettingsStore`, extend beyond booleans), `src/server.ts` (`/api/settings/feature-flags` POST — generalize), `src/confidence.ts`/`src/validator.ts` (scalar trust becomes one policy input).
- **Build vs Buy:** borrow the pattern; borrow the *idea* of a terminating expression language but **do not adopt a CEL runtime yet** — a small typed predicate DSL / structured match objects cover glance's current rules; a full CEL dep is integration tax the alpha doesn't need. Revisit an off-the-shelf terminating evaluator when rules outgrow structured matches.
- **Cost:** mutable server-side policy is a new attack/ops surface (keep loopback/admin-gated like the current settings POST); ship the tighten-only invariant as an enforced test — it's the whole safety story.

### 3. Pre-execution cost/risk gates — turn spend from a receipt into a veto
- **Pattern:** a run's projected cost and blast radius are evaluated *before* dispatch/land against a budget and risk threshold; over-budget/over-risk work is denied or escalated, not executed then accounted for.
- **Mechanism:** glance already has the ground truth to predict — `attribution-scoreboard` joins per-model `$/landed-change` and per-tier land-rate. At dispatch, estimate a unit's cost from complexity-tier × chosen model's historical $/change and refuse/escalate if it blows a per-unit or per-fleet budget; at land, treat an unusually large diff or a touched protected path as a risk score forcing human ASK. Same engine as #2 (a budget is a policy input).
- **Value:** hands-off autonomy without a spend ceiling is how a fleet burns money overnight. glance's cost today is pure post-hoc observability (`receipts`, `model-outcomes`, `attribution-scoreboard`); the only pre-exec "budget" in `dispatch.ts` is a concurrency WIP cap. A pre-exec cost gate is what makes "run the fleet overnight" safe.
- **Where:** `src/dispatch.ts` (dispatch decision + existing concurrency `budget`), `src/intake.ts` (routing/tier assignment), `src/attribution-scoreboard.ts` + `src/model-outcomes.ts` + `src/receipts.ts` (history to project from), `src/land.ts`/`src/land-mode.ts` (land-time risk ASK). Enforced through the same seam as #2.
- **Build vs Buy:** borrow — all inputs already exist; this is wiring history into a forward gate.
- **Cost:** cost projection is noisy with thin history — ASK-on-uncertainty (or warn-only shadow mode) before hard-DENY until the scoreboard has volume.

### 4. Portable, forkable session object — deepen step-in beyond a read-only screen
- **Pattern:** a running unit's session is a server-held, addressable object you can attach to, hand off across surfaces, and **fork** — branch a running conversation to try a correction without disturbing the original.
- **Value:** the step-in half of glance's north star tops out at a read-and-act screen. Intervene View derives "why it stopped" + the one resolving action — excellent, but it's a control panel, not a portable/forkable session. Forking is the missing move: when a unit stalls, fork its session to explore a correction in parallel while the original keeps running (glance already gives every unit an isolated git worktree, so forking the worktree is architecturally consistent). Genuinely new step-in capability, not a reskin.
- **Where:** `webapp/src/lib/intervene.ts` + `webapp/src/components/IntervenceView.tsx` (extend from "act" to "fork"), `src/sessions.ts` + `src/presence.ts` (session/presence tracking), `src/worktree.ts` (worktree isolation a fork branches), `src/rpc-agent.ts`/`src/acp-agent-driver.ts` (driver session/resume; `resumable` capability already gates reattach).
- **Build vs Buy:** borrow. Fork = snapshot the session + branch the worktree, both primitives glance owns.
- **Cost:** forkable server-side sessions multiply live state/ops surface; scope v1 to "fork a *stopped/blocked* unit" (no concurrent-write race) before live co-drive.

### 5. A native, first-class unit driver for human-parity harnesses (PTY / ACP approval reflection)
- **Pattern:** wrap a vendor CLI's *own* interactive terminal so its native approval prompts and UI reflect into the common surface — giving a non-omp harness true parity as a unit runtime.
- **Value:** glance's seam is shallower than its ambition — `harness-registry.ts` supports exactly two protocols (`omp-rpc`, `acp`), so Claude Code is reachable only via the `@zed-industries/claude-code-acp` bridge, inheriting ACP's `contextInjection:"mcp"` and `toolApproval` limits rather than the CLI's native prompts. A native driver (or a first-class ACP path that reflects native approvals) widens which runtimes can be genuinely hands-off units. More reinforcing than #1–4, but the delta is real.
- **Where:** `src/harness-registry.ts` (`HarnessProtocol`, `CapabilityDescriptor.toolApproval`), `src/acp-agent-driver.ts` (bridge to improve), `src/agent-driver.ts` (`AgentDriver` contract), `plans/harness-agnostic-drivers/DESIGN.md`.
- **Build vs Buy:** borrow; a PTY-wrapping approach is a heavy maintenance commitment — prefer extending the ACP path to *reflect native approvals* before writing per-harness PTY scrapers.
- **Cost:** native PTY parity vs maintenance load + upstream-CLI fragility — pin to structured protocols wherever the vendor offers one.

### Already-converged / low-delta — no dedicated action
- **Meta-harness bet** — glance already made it (`src/agent-driver.ts` + `src/harness-registry.ts`). Pure reinforcement.
- **Host self-registration** — adjacent to federation (`src/federation.ts`, `src/federation-sync.ts`). Converged.
- **Sandbox breadth** — glance has one hardened Docker path (`src/gate-runner.ts`); pluggable cloud sandboxes are breadth, not a north-star gap. Defer until a non-Docker target is needed.
- **Full-stack OpenTelemetry** — glance has cost ingesters + `src/spans.ts`/`src/trace-exporter.ts`, not distributed browser+server tracing. Low leverage for hands-off/step-in; skip.
- **Multi-surface native clients** — glance has web-push (`src/push.ts`, `AttentionPanel`); native OS clients are reach, not a trust gap.
- **CUJ-map + failure-branch discipline** — worth adopting as a `plans/` convention, but docs not code; lowest leverage of the actionable set.
- **Declarative one-YAML agent authoring** — glance units are imperative (`src/agent-profiles.ts`); a real future gap but subordinate to the policy-as-data work in #2 (do #2 first; agent-authored-agents layer on the same schema later).

---

## Handoff to /plan (recommended)

**Actionable, ranked:**
1. **Cross-lineage adversarial review** — highest ROI, smallest surface, directly raises the unattended-land ceiling. Nearly-free given glance's existing multi-vendor fleet. **Start here.**
2. **Layered tighten-only policy-as-data engine** — biggest structural gap; unifies scattered gates (agent-guard regex, feature flags, validator veto) into one testable, runtime-mutable stack. Folds in the terminating-expression and live-mutation ideas. Larger build.
3. **Pre-execution cost/risk gates** — the "safe to run overnight" primitive; rides on #2's engine, reuses the existing scoreboard. Do after/with #2.
4. **Forkable session object** — deepens step-in; v1 = fork a stopped/blocked unit.
5. **Native/ACP approval-reflecting driver** — widens which harnesses are true units; heaviest maintenance, most reinforcing.

**Build-vs-buy verdict:** borrow every pattern; adopt no dependency. Explicitly **do not** pull in a CEL runtime yet — structured match objects cover glance's rules; revisit only when they outgrow it.

**Suggested first plan:** #1 (cross-lineage review) as a tight standalone, then #2+#3 as a combined "policy-as-data + pre-exec gates" plan since they share the enforcement seam.
