# Research Brief: t3code (T3 Code)

## Provenance

- **Date researched**: 2026-07-15
- **Source**: https://github.com/pingdotgg/t3code
- **HEAD SHA inspected**: `ecb35f75839925dd1ac6f854efeef5c9e291d11b` (2026-07-15, same-day-active repo)
- **Latest stable release**: v0.0.28 (2026-06-29); nightlies ship continuously (`v0.0.29-nightly.20260715.816`)
- **License**: MIT (T3 Tools Inc.). 14,031 stars / 2,975 forks, repo created 2026-02-08.
- **Access**: read-only via `gh api` + source reads. No code cloned, built, or executed.
- **Target project**: glance (omp-squad) — this repo.

## Scout brief (facts)

### What it is

A minimal web GUI for coding agents — **not an agent itself**. A unified control surface (web + Electron desktop + native iOS/Android) that spawns and multiplexes other vendors' coding agents (Codex app-server via JSON-RPC, Claude via `@anthropic-ai/claude-agent-sdk`, Cursor and Grok via ACP, OpenCode via SDK) behind one chat/session/diff/terminal UI with uniform checkpointing.

### Architecture (verified against source, not README)

- Monorepo: `apps/server` (Node, the brain, npm package `t3`), `apps/web` (React 19 + Vite + xterm.js), `apps/desktop` (Electron shell spawning a local `t3` backend), `apps/mobile` (Expo/RN with custom Swift/Kotlin terminal/diff/markdown native modules), `packages/contracts` (effect/Schema wire contracts for everything).
- **Effect-TS v4 beta (`effect@4.0.0-beta.78`, effect-smol) as the entire backend substrate** — DI, typed errors, Schema-validated wire boundaries. Same bet glance made.
- **Event-sourced orchestration core**: `decider.ts` (pure command+state→events) + `projector.ts` (read model) + `ServerPushBus` (ordered typed pushes). Chosen for deterministic replay/testing without a live agent process.
- **RuntimeReceiptBus + DrainableWorker queues**: async follow-up work (checkpoint capture, diff finalization) emits typed receipts (`checkpoint.baseline.captured`, `turn.processing.quiesced`) that tests and orchestration *await* instead of polling.
- **Checkpoints are hidden Git refs** (`apps/server/src/checkpointing/CheckpointStore.ts`): capture/restore/diff via a resolved `VcsDriver`'s optional `checkpoints` capability using an isolated temporary Git index — per-turn, provider-agnostic, independent of any agent's own rollback mechanism.
- **`ProviderDriver<Settings, Env>` seam** with 5 implementations; multi-instance per driver kind (`codex_personal` + `codex_work`) with per-binary+HOME capability caches so two accounts never cross-contaminate; `continuationIdentity` + `resumeCursor` for session resume across restarts.
- **Hosts its own MCP HTTP server** (`/mcp`, bearer-token per provider instance) exposing a `preview` toolkit — `preview_snapshot` returns a base64 PNG of the agent's dev-server preview, handed *back to the driven agent* so it can see its own UI work.
- **Remote access architected as a seam**: `ExecutionEnvironment` (one running server owns auth/projects/terminals/git) vs client-local endpoints, with real `packages/ssh` and `packages/tailscale` transports.
- **Permissions**: a coarse two-mode dial — "Full access" (default: `approvalPolicy: never`, `sandboxMode: danger-full-access`) vs "Supervised" (`on-request` + `workspace-write` + in-app approvals).
- **Agent-facing engineering discipline**: an in-repo oxlint plugin (`oxlint-plugin-t3code`) enforcing Effect-service conventions, plus `.macroscope/check-run-agents/effect-service-conventions.md` — convention docs written *for AI agents reviewing PRs*. The project dogfoods agents heavily (~25–30 PRs/day, `[codex]`-prefixed PRs, codex co-author trailers, 162 contributors while officially "not accepting contributions").

### Notable divergences and gaps

- `docs/architecture/providers.md` claims "Codex is the only implemented provider" while `ClaudeDriver.ts`, `CursorDriver.ts`, `GrokDriver.ts`, `OpenCodeDriver.ts` are fully implemented — real docs/code drift.
- **No multi-agent orchestration**: single active agent per thread. No autonomous landing pipeline, no verification gauntlet, no fleet.
- **No cost/usage tracking found** (LOW-CONFIDENCE on total absence; no named module exists the way `checkpointing`/`orchestration` do).
- No user-facing skills/hooks/subagents layer — extensibility is entirely at the provider-driver seam; prompt/tool-layer extension is delegated to the underlying agent.

## Strategist: ranked transferable concepts

Comparator round skipped (single target); concept extraction folded into this pass. Glance and t3code independently converged on the same skeleton — harness-agnostic driver seam (glance `src/agent-driver.ts` + `src/harness-registry.ts` ≈ t3code `ProviderDriver`), Effect v4 + Schema wire contracts, ACP for foreign harnesses, web UI over a local daemon, Electron shell plan (glance-desktop). The borrows below are where t3code is genuinely ahead; the strategic section notes where glance is ahead.

### 1. Typed completion receipts instead of polling for async quiescence

**Pattern**: Every async follow-on job (checkpoint capture, diff finalization, post-turn processing) emits a schema-typed receipt event on a dedicated bus when it settles (`checkpoint.baseline.captured`, `turn.processing.quiesced`). Orchestration code and tests *await the receipt*, never sleep/poll/guess.
**Mechanism**: queue workers wrap each job; on completion they publish `{kind, correlationId, outcome}` receipts validated by Schema; a helper `awaitReceipt(kind, correlationId, timeout)` turns "is the system quiet yet?" into a deterministic await.
**Value for glance**: this is honesty-as-architecture applied to *time*. The verify-loop thrash on hard units, the burr-era `replay_complete` settle hack, and the `lifecycle-truth` plan's durable-pending concern (`plans/lifecycle-truth/04-durable-pending.md`) are all symptoms of the same missing primitive: nothing in the daemon says "this async consequence has fully landed." A receipt bus makes lifecycle claims provable and kills a whole class of flaky gate runs.
**Where it applies**: `src/agent-lifecycle.ts`, `src/workflow/engine.ts` + `src/workflow/executor.ts`, `src/automation-log.ts`; directly extends `plans/lifecycle-truth` (01-lifecycle-write-path, 04-durable-pending).
**Build vs Buy**: build — it's a small typed event bus + await helper on infrastructure glance already has.

### 2. Per-turn hidden-git-ref checkpoints, harness-agnostic

**Pattern**: The orchestrator checkpoints the working tree after every agent turn as a hidden git ref (via an isolated temporary index, no touching the real index or HEAD), giving uniform capture/restore/diff across every harness regardless of that harness's own history/rollback story.
**Mechanism**: `GIT_INDEX_FILE=<tmp>` + `git add -A`/`write-tree`/`commit-tree` → store the commit under `refs/glance/checkpoints/<unit>/<turn>`; restore = `read-tree`+`checkout-index`; diff = `diff <refA> <refB>`. Optional `checkpoints` capability on the VCS driver so non-git backends degrade gracefully.
**Value for glance**: glance checkpoints at branch/worktree granularity (unit-level); turn granularity is what powers surgical intervention. `plans/never-lose-work/03-checkpoint-log-and-terminal-marker.md` and `04-fork-command-and-api.md` describe exactly this need — fork-from-turn-N, diff-as-spine in the Intervene view, and "the engine died mid-unit, what survived?" all become ref lookups instead of forensics. Works identically for claude, codex, and grok-ACP units because it's outside the harness.
**Where it applies**: `src/workflow/checkpoint-log.ts` (exists, workflow-level — extend downward to turns), `src/agent-driver.ts` post-turn hook, Intervene view diff spine; slots into the existing `plans/never-lose-work` plan rather than a new one.
**Build vs Buy**: build — plain git plumbing, ~a day, no dependency.

### 3. Host-hosted MCP toolkit handed back to the driven agent (preview screenshots)

**Pattern**: The orchestrator runs its own MCP server exposing capabilities the *driven agent* lacks — headline tool: `preview_snapshot`, returning a base64 PNG + page metadata of the agent's dev-server preview, so the agent can visually verify its own UI work mid-session.
**Mechanism**: HTTP MCP endpoint on the daemon, bearer-token scoped per agent/unit; screenshot via a headless browser the daemon owns; the agent's harness config gets the MCP endpoint injected at spawn.
**Value for glance**: glance already has the host-tools seam (`set_host_tools` in `src/rpc-agent.ts`) and the make-it-work finding stands: *the webapp is the frontier* and units routinely ship UI changes they never saw render. A daemon-hosted `preview_snapshot` closes the loop — fleet units verifying webapp work stop needing the operator's eyes or a hand-rolled agent-browser dance per unit.
**Where it applies**: `src/rpc-agent.ts` / `src/agent-host.ts` host-tool surface, spawn-time harness config in `src/harness-registry.ts`; pairs with the scratch-daemon verification choreography.
**Build vs Buy**: build the tool on the existing seam; reuse whatever headless-browser dependency the agent-browser skill already uses rather than adding playwright anew.

### 4. Multi-instance harness registry with isolated per-instance identity

**Pattern**: The same driver kind runs as N named instances (`codex_personal`, `codex_work`), each with its own auth, settings, display identity, and a capability/version cache keyed by binary-path+HOME so instances never cross-contaminate.
**Value for glance**: DB-mode BYO keys (#172) solved org-level isolation; instance-level is the next ring — one org running work and personal Claude accounts, or two codex accounts with different rate-limit pools, routed per-unit. Also enriches per-harness cost attribution (#70's ingesters gain an instance dimension for free).
**Where it applies**: `src/harness-registry.ts`, `src/agent-profiles.ts`, cost ingesters.
**Build vs Buy**: build — registry keying change plus config schema; medium effort, and lower urgency than 1–3.

### 5. Convention enforcement written for AI agents (lint rules + reviewer-consumed convention docs)

**Pattern**: Codify the codebase's non-obvious conventions twice — once as custom lint rules that fail mechanically, once as short convention docs explicitly addressed to AI agents reviewing PRs — because when agents author most commits, tribal knowledge must live in the gate, not in humans.
**Value for glance**: glance's fleet writes most of its code and the ratchet already exists (`src/convergence-ratchet.ts`), but the Effect-adoption defect class (`Number(env)||default` eating legitimate 0s across 34 sites) is exactly what a convention lint rule prevents and what a reviewer-facing convention doc would have put in every gauntlet brief. t3code proves the pattern scales to ~30 agent-authored PRs/day.
**Where it applies**: ratchet rule set, `.claude/skills/blind-review` and code-review briefs (a `conventions.md` the gauntlet always loads), oxlint/eslint custom rules for the Effect v4 idioms glance standardized in #76/#81–#87.
**Build vs Buy**: build — the mechanism is boring; the value is writing the rules down.

### 6. First-class continuation identity on the driver seam

**Pattern**: Every driver stamps a `continuationIdentity` + `resumeCursor` on its sessions so the orchestrator can resume any harness's session across daemon restarts uniformly, instead of per-harness reconnect heroics.
**Value for glance**: the dead-agent honesty + self-heal work (a192134) rebuilt connections ad hoc; lifting resume identity into the `AgentDriver` interface (`src/agent-driver.ts`, `src/acp-agent-driver.ts`) makes restart-survival a seam guarantee rather than per-driver behavior.
**Build vs Buy**: build; fold into any next driver-seam touch rather than a standalone effort.

## Strategic intel (not borrows — round 1)

- **t3code validates the fleet-first IDE bet and marks the differentiation line.** Its desktop architecture (Electron shell spawning a local backend, shared web app, remote environments over ssh/tailscale) is glance-desktop's architecture, shipped, with 14k stars in 5 months. What it does **not** have: multi-agent fleets, autonomous landing, verification gauntlets, cost accounting, trust tiers, or any prompt-layer extensibility. Glance's moat is the trust/landing/verification layer — t3code is a cockpit for one agent at a time; glance is a factory. Worth stating in `plans/fleet-first-ide` positioning.
- **Independent confirmation of the Effect v4 bet**: a second high-velocity team committed to `effect@4.0.0-beta` in production, and found it needed lint-enforced discipline to survive many hands (see borrow 5).
- **Anti-pattern to keep avoiding**: full-access-by-default permissions (their default session runs `danger-full-access`, approvals off) and docs that lag implemented reality by months (providers.md). Glance's #157 permission-gate fix and reality-audit habit are the right side of both.
- **Their velocity mechanism is visible**: vouch-tier PR labels + agent co-authorship + convention docs for reviewer agents ≈ a lighter-weight cousin of glance's gauntlet. Nothing to copy beyond borrow 5, but a useful comp for "what 30 agent PRs/day looks like without a landing interlock."

---

# Round 2 — daily-use deep dive (2026-07-15, same day)

Lars's redirect: t3code is built by someone who uses it daily; glance's builder doesn't use glance at all yet. Round 2 therefore mines what daily dogfooding *selected for* — the product opinions, the pain-fix stream, and the founder's actual workflow — and maps the gap onto glance. Three parallel scouts: product-UX code deep-read (same SHA `ecb35f7`), PR/issue history mining (800 recent PRs / 300 issues sampled, recency-biased), public-narrative research (sourced; X/YouTube reached only via search snippets and podcast-summary sites — those claims marked secondhand).

## A. How Theo actually uses it (public narrative)

- **Sequential, not parallel.** Despite parallel worktrees being the headline feature, Theo runs threads one at a time, start-to-finish, directly on `main` — "probably over 100 threads" in 5 days for one project, none concurrent. Quote: "I don't want old context getting in the way." (secondhand via podcast summary of his own video)
- **Two-sentence voice prompts**, not long plans; he moved away from detailed planning docs. Speech-to-text because speaking produces better instructions than typing.
- **Reads the reasoning, not the diff**: "devs care more about the code output and not enough about what it said and that's entirely backwards." Verification is delegated to autonomous loops (browser automation, CLI checks), not line-by-line review.
- **The multi-machine control plane is what he raves about**, not parallel agents: "Working on 3 projects with 2 harnesses across 4 dev machines, all from one (open source) interface"; "I barely open the desktop app anymore, I just use the site and the [mobile] app." A Framework desktop as home server runs "a dozen threads... barely breaking a sweat."
- **Primary brain**: GPT-5.5 via Codex harness (reversed from all-in on Opus ~5 months earlier).
- **Origin story**: Anthropic's hostility to Claude Code wrappers (header blocks, system-prompt string-matching, billing-by-prompt-text) pushed him to Codex, whose open app-server made a third-party GUI buildable: "We are building on top of the Codex CLI the exact same way the Codex app team is."
- **Philosophy**: "presentation layer, not a new AI engine" — the power comes from the agent, not the GUI. Deliberately excluded: code editor, LSP, inline suggestions, token-by-token streaming (finished turns only), monorepo workspace features. "I like using things as close to stock as possible."
- **Reception check**: praised for Linux support, worktree isolation, one-click PR, and performance-per-Electron-app; dinged hard on orchestration overhead (one benchmark: same task 4m35s in raw Codex CLI vs 15+ min through t3code) and early-days bugs. HN launch flopped (4 points); distribution was entirely his audience.
- **Business**: MIT, BYOK, no token reselling, free; T3 Connect (relay for cross-machine + mobile push) is the obvious future monetization, unpriced today. Self-critique in July: heavy multi-machine use "is making a lot of the UX feel less than ideal."

## B. Frozen usage opinions in the product code (UX deep-read)

Everything below verified against source at `ecb35f7`; paths in apps/web, apps/mobile, apps/server.

- **Ten-second on-ramp**: `npx t3@latest` → auto-bootstraps a Project from cwd + a first thread, browser opens pre-paired (one-time pairing token in the URL). No wizard. Provider auth is delegated entirely to the provider CLIs' own logins. One command + one send to first agent turn.
- **Defaults are pure dogfood opinion**: runtime mode `full-access` (unsandboxed, approvals off), **no worktree** — first thread runs directly on cwd; Codex is the default brain; safety rails (worktree isolation, supervised mode) all opt-in. The tool assumes you want to work *now*.
- **Attention routing is the most engineered UI subsystem**: six mutually-exclusive thread states with an explicit priority ladder — Pending Approval > Awaiting Input > Working/Connecting (pulsing) > Plan Ready > Completed-unseen (tracked via completion-timestamp > lastVisitedAt) — rolled up to project headers, rendered in the command palette rows too, with PR-state and running-terminal badges. Sidebar prewarms the first 10 threads' state so switching is instant.
- **The composer is the hub; every surface feeds it**: terminal text selection → "Add to chat" context chip; diff line-range comment → becomes part of the *next send* (not a PR review); preview annotations and element-picker contexts → typed prompt segments; @-file mentions and skill mentions are first-class parsed tokens. One data-flow opinion applied everywhere: review artifacts are prompt inputs.
- **Input is sacred**: composer drafts persist to localStorage at schema **version 8 with migrations back to v2** (they lost user drafts at least six times and kept fixing it), debounced 300ms with `beforeunload` flush; typing is never blocked mid-run — messages queue, and the mobile send button honestly relabels itself "Queue" with a queued-count banner.
- **Attention is paged to the phone, not the browser**: zero web-push/OS-notification code in apps/web (in-tab pills only); mobile has per-category push toggles (approval / input / completion / failure as separate booleans), tap-to-deep-link, and iOS lock-screen Live Activities armed the moment work starts. Mobile is a full driving app (start tasks, add projects, review diffs natively, git actions, terminal), not a monitor.
- **Interrupt semantics are simple**: one-click Stop; four-button approvals (Approve once / Always allow this session / Decline / Cancel turn); a structured multi-question pending-user-input flow. No mid-turn steer primitive exists — steer = stop or queue.
- **Not found (absence as signal)**: partial-hunk accept, web push, auto-titling threads, mid-turn steer, provider OAuth in-app.

## C. The change history as usage diary (800 PRs / 300 issues sampled)

- **The pain-fix stream is real and specific**: scroll-anchoring after send, native composer lag, provider state corrupting while typing, stale working-task push notifications, looping macOS TCC prompts, reconnect storms after laptop wake, draft-selector persistence — the canonical "only exists because someone lived in it" class. Desktop packaging breaks get fixed same-day (they block the maintainers' own builds — fastest-fixed theme in the dataset).
- **Most continuously fixed subsystems = most used**: worktrees (built day 1, 19+ follow-up fixes across 5 months, still being touched) and the mobile app (two full waves, 14 hardening PRs in one day, Android beta push in July). Multi-provider switching is a *permanent* low-grade friction source, never "done".
- **Agent-authorship reality check**: 59% of recently-merged PRs are one mechanical `[codex]` Effect-error-hardening campaign (227 merged on a single day, 2026-06-20, under one engineer's account). Theo himself authored 11 of 473 sampled merges — taste calls only (browser preview, mobile stack, marketing). Meanwhile autonomous cursor-bot sweeps produced 105 closed-unmerged PRs vs 6 merged: **directed agent campaigns land; undirected autonomous sweeps get discarded** — even in the most agent-forward dogfood shop.
- **Vouch/size gates work as stated**: `size:XXL` is 11% of merged but 28% of closed-unmerged; reasonable external feature PRs get closed on principle.
- **The lingering big asks are exactly glance's territory**: subagent support as nested threads (#538, open 4+ months), conversation branching (#1404), Steer + Queue follow-up modes (#231), Orchestration/Delegation (#3138), Automations/Triggers "for loops" (#3164) — all `In Progress`, all blocked on an in-flight event-sourced orchestration rewrite (branches `codething/orchestration-engine`, `codething/event-sourced-core-engine`). Also still open: a 136×-normal energy-consumption bug (#3143).

## D. Strategist synthesis: what daily use selected for

Seven laws, each earned by the evidence above rather than designed up front:

1. **Time-to-first-turn is the whole ballgame.** One command, zero config, run on cwd, full access, safety opt-in. Start-of-session friction compounds dozens of times a day; the tool that wins daily use is the one you can pick up mid-thought.
2. **Attention is the scarce resource; routing it is the product.** The founder runs a dozen threads across four machines — the entire value is "which thread needs me, on whatever screen I'm looking at." Hence the six-state priority ladder, per-category phone push, lock-screen widgets, and finished-turns-only display (no token streaming = no attention churn).
3. **Cheap thread turnover beats parallel ceremony.** The founder doesn't use parallel worktrees — he uses instant sequential threads with fresh context ("I don't want old context getting in the way"). What daily use demands is that a new thread costs nothing, not that ten run at once. Parallelism earns its keep across *machines and projects*, not within one task.
4. **Every surface is a prompt composer.** Terminal selections, diff comments, preview annotations — all become typed segments of the next turn. No parallel review system; the conversation is the only write path to the agent.
5. **User input is sacred; agent state is merely recoverable.** Eight schema versions of draft persistence, queue-not-block, crash-flush. Losing an agent turn is annoying; losing what the human typed is unforgivable.
6. **The founder reviews reasoning, not diffs — and delegates verification to loops.** The review surface that matters daily is "what did it think and what did it check," not line-by-line hunks (no partial-accept exists, and nobody misses it).
7. **Directed campaigns land; undirected autonomy is discarded.** Their own history: human-directed codex sweeps = 59% of merged volume; autonomous bot sweeps = 95% closed unmerged. Autonomy needs an owner with intent.

## E. The gap map: why glance isn't Lars's daily driver (and t3code is Theo's)

The uncomfortable symmetry: glance was built *about* agents but *through* Claude Code — this very research session included. The `glance vs direct diagnosis` memory already mined 7 reasons direct Claude Code wins; t3code shows what closes that loop: the builder's own work must flow through the tool, or the pain-fix stream (t3code's ~25 lived-in fixes/week) never starts. Concretely, judged against the seven laws:

- **Law 1 (ten-second on-ramp): glance's biggest gap.** t3code: `npx t3` in any repo → typing to an agent in seconds, riding your existing provider login. glance: daemon launch topology, state dirs, file-vs-DB mode, project registration, unit/plan ceremony — a factory you *operate*, not a tool you *pick up*. There is no "just open a thread on this cwd right now" gesture.
- **Law 2 (attention routing): glance is half-built here.** Web push exists (#83's attention lane), FLEET PULSE exists, the cockpit's roster/attention panes shipped — but there is no unified needs-you priority ladder with unseen-completion semantics and per-category delivery, and nothing pages a phone.
- **Law 3 (cheap thread turnover): glance's units are heavyweight by design** (worktree, gates, landing). Right for the factory lane; wrong as the *only* lane. The interactive "just a thread on my checkout" mode doesn't exist.
- **Law 4 (everything feeds the composer): glance is close** — intervene view already does line-comment→steer. Terminal-selection→prompt and annotation→prompt don't exist.
- **Law 5 (input sanctity): unaudited** — whether webapp chat drafts survive reload/crash is unknown; nobody has typed enough real prompts into glance to have lost one yet. That fact is itself the finding.
- **Law 6 (reasoning-first review): glance's trust surfaces are diff- and gate-centric**; a "what did it think/check" spine exists in why-stopped but isn't the default reading surface.
- **Law 7 (directed campaigns): glance is *ahead*** — the interlock/gauntlet architecture is precisely the "autonomy needs an owner" lesson, learned independently.

## F. Round-2 ranked borrows (usage-driven; complements round-1's architecture borrows)

1. **The casual lane: `glance here` (or equivalent) — one command, thread-on-cwd, zero ceremony.** Auto-register cwd as a project, open a chat thread against a default harness instance riding the user's existing CLI login, full-access by explicit choice, browser opens pre-authed. Escalation path "promote this thread to a unit" bridges into the factory (worktree, gates, landing) only when wanted. Where: CLI entry + daemon bootstrap + webapp draft-thread route. This is the adoption unlock — without it, laws 2–6 have no user.
2. **A needs-you priority ladder as the attention primitive.** One computed state per unit/thread — Pending Approval > Awaiting Input > Working > Ready > Completed-unseen (lastVisited tracking) — rendered identically in webapp sidebar, cockpit roster, and push payloads, with per-category delivery toggles. Where: daemon attention lane (#83), webapp sidebar, glance-desktop fleet module bells.
3. **Composer input sanctity**: versioned draft persistence with crash flush; queue-not-block sends with an honest "Queue" affordance. Where: webapp chat composer / console-prompt.
4. **Everything-feeds-the-composer**: terminal-selection→chat chip and annotation→prompt segments on the intervene/console surfaces, extending the existing line-comment→steer.
5. **Reasoning-first thread reading surface**: finished-turns timeline that leads with the agent's stated reasoning/checks, diff one click away — matching how a daily power user actually reviews.
6. **Measure glance's own orchestration overhead** vs raw harness on an identical task (t3code's 3× overhead complaint is the cautionary tale); publish the number in the repo and ratchet it.

## G. Strategic intel (round 2)

- **The moats are converging from opposite shores.** t3code is building toward glance (event-sourced orchestration rewrite in flight, subagents/branching/steer on the roadmap, all `In Progress` for months); glance already has that backend but lacks t3code's daily-driver surface. Whoever crosses the gap first owns both lanes. glance's window on the orchestration side is real but not indefinite.
- **Dogfooding is the product strategy, not a virtue.** t3code's entire polish delta is downstream of the builder living in it. The single highest-leverage act for glance is Lars running real daily work through it — which requires borrow F1 first.
- **Distribution lesson**: 14k stars with a 4-point HN launch — audience-driven, not community-driven; and "not accepting contributions" didn't hurt growth. Polish + openness + a famous dogfooder was the whole engine.
- **Anthropic-wrapper risk, confirmed from the builder's mouth**: t3code exists because Codex's app-server is open while Anthropic actively blocks wrappers. glance's multi-harness driver seam (and vendor-pinned verified harnesses) is the right hedge; treat any Claude-Code-only integration path as strategically fragile.
