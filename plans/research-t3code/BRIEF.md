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

---

# Round 3 — chat-surface construction deep-dive (2026-07-20)

## Provenance

- **Date**: 2026-07-20. **Source**: https://github.com/pingdotgg/t3code/tree/main/apps/web/src/components/chat (Lars's pointer), HEAD SHA `5d34f9ff` (pushed 2026-07-20 14:22 UTC — scouted same-day-fresh).
- **Question (Phase 0)**: how does t3code actually build its conversation surface — timeline, tool rows, changed-files card, composer — and what transfers concretely to glance-desktop's hub-shell work (pending H1/H3/H4/H5, merged H0/H2, t3-face 11/13)? Rounds 1–2 answered architecture and daily-use; this round is the construction detail for the surface Lars will judge.
- **Method**: read-only. Blob-lazy clone; two source scouts (timeline side, composer side), one git-history scout (138 commits on the dir, 2026-03-11→2026-07-20), one target-map scout over glance-desktop. Nothing built or executed.
- **Named bottleneck ranked against**: Lars's first-frame / first-thread-read reaction ("does it feel like t3code now?") — the hub-shell milestone gate and t3-face concern 13. Foundation loved before features (DIRECTION.md).

## Corrections to earlier rounds

- **Round 2 claimed "queue-not-block sends with an honest Queue affordance."** The web composer at `5d34f9ff` has **no message queue at all** — while a turn runs the only action is Stop (`ComposerPrimaryActions.tsx` priority ladder; grep confirms no staging mechanism). The round-2 claim came from mobile send-button code and should be treated as mobile-only or removed. Consequence: glance's mid-turn steer (which t3code lacks, issue #231 still open) remains a genuine capability lead, and "queue" should not be treated as reference behavior.
- **"Pierre" is two vendor artifacts, not a review persona**: `@pierre/diffs` (npm diff renderer + shared Shiki highlighter) and a file-type SVG sprite icon system (`PierreEntryIcon`, per-language light/dark color table incl. `claude` and `mcp` tokens). Don't port it as if it implies a review workflow.

## Practice axis — the churn diary of the chat dir (138 commits)

- **Half of all commits touch two files**: `MessagesTimeline.*` (111 touches across variants) and `ChatComposer.tsx` (38). The surfaces the cursor lives on absorb the polish; pickers/banners/trees churn only in feature bursts. **Budget rule for glance: spend taste-review time on timeline + composer over rail/pickers, at roughly that ratio.**
- **Scroll is their most chronic unsolved pain**: 9 commits, five approaches over 4.5 months (virtualize → LegendList → upgrades → autoscroll/anchoring stabilization → minimap → minimap hover scoping, still tuning 07-20). Validates t3-face's decision to defer virtualization — and warns that whatever scroll behavior glance ships will need iteration.
- **`ChatComposer` was extracted from the ChatView monolith specifically to kill keystroke re-renders** (#1857), with 8 later commits still chasing rerender storms. Input latency is an engineering workstream there, not polish.
- **The changed-files card took a 40-day arc**: extract (06-10) → sticky-header polish → icon adoption (06-15) → "Finale: upgrade changed files card" (07-20). Expect H3 to need live iteration under Lars's eyes; ship early, don't gold-plate v1.
- **Fresh since round 2 (07-15)**: draft-hero empty-state landing (#4055, 07-18 — regressed within 2 days, #4164), drag-files-from-explorer-into-composer (#4140), complete approval details (#4111), changed-files Finale (#4113). The empty-state/on-ramp surface is under active investment right now.
- **`[fix/feat:ui]` commits land in same-day clusters** (three on 07-18: menu-check color, brand colors, default badge) — batch UI-polish sweeps as a dedicated pass, the same shape as glance's chrome-polish concern 11.

## Artifact axis — how the surface is actually built

### Timeline (`MessagesTimeline.tsx` + `.logic.ts` + `session-logic.ts`)

- **Row pipeline**: activities+messages+plans merge → sorted by `createdAt` → `deriveMessagesTimelineRows` emits a flat discriminated-union row list (`work | work-toggle | turn-fold | message | proposed-plan | working`) → virtualized `@legendapp/list` renders 1 row = 1 item. Tool lifecycle updates **collapse in place** by `toolCallId`-derived key (one row mutates rather than appending); subagent/task activities are explicitly excluded from collapsing so their progress lines stay visible.
- **Turn folds**: settled turns collapse behind "Worked for {duration}" / "You stopped after {duration}"; the terminal assistant message always stays visible below the fold. Duration start falls back to the **user message's timestamp** (provider output starts late). Interrupt **auto-re-expands** the turn so the user keeps their place; starting a new turn auto-collapses the previous latest. `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` with a "+N previous tool calls" toggle — glance's identical constant in `deriveRows.ts` is **validated, not a gap**. Pure tool-call groups render zero heading chrome; mixed groups get a small "Work Log" label.
- **Tool rows**: heading = server `toolTitle` → strip trailing "completed" → capitalize; preview = command > detail > first changed file (+N more), suppressed when it duplicates the heading; shell wrappers (`bash -c`, `pwsh -Command`, `cmd /c`) unwrapped for display; failure = explicit status OR text heuristic (exit codes, ENOENT, "command not found"); right-edge status affordance: chevron only when expandable, red X / check / minus-"Empty" (neutral empty output settles to a check when the turn ends). Expanded body is a `<pre>` with left border rail, 16rem max scroll, `stopPropagation` so text selection doesn't collapse the row.
- **Scroll: three named modes** (`timelineScrollAnchoring.ts`): `following-end` (stick-to-bottom via list's maintain-at-end), **`anchoring-new-turn`** (on send, the user's message pins 16px from viewport top and trailing space is reserved so the reply grows *downward into it* — no transcript re-scroll per token; pure math decides when the turn outgrows the anchored viewport), `free-scrolling` (user navigated away; "near end" counts as following). Plus a hover-only **minimap** gutter: one tick per user message, floating preview card (user text + 3-line assistant answer), keyboard nav, only when a ≥48px persistent gutter exists and ≥2 items.
- **Performance is a three-part system** (porting one part alone silently no-ops):
  1. Row components read shared state from **two React Contexts, not props**, so the virtualizer's memoized `renderItem` (zero-dep callback) never busts on parent re-renders.
  2. A **structural-sharing pass** (`computeStableMessagesTimelineRows`) diffs each freshly-derived row against last render's by id+shallow-fields and reuses old object references — this is what makes row `memo()` effective at all.
  3. **Self-ticking timers mutate `textContent` via refs** (no React re-render per second); status-pulse keyframes are **duty-cycled with `steps()`** so the compositor produces frames ~20% of the cycle instead of every vsync (explicit battery/perf comment).
- **Feel carriers**: no avatars anywhere — role is alignment (user right in a `bg-secondary rounded-2xl` bubble max-w-[80%], assistant left as plain text); user messages past 600 chars/8 lines collapse behind a gradient mask + "Show full message"; copy/timestamp affordances are `opacity-0 group-hover:opacity-100` (200ms); empty state is one quiet line at `text-muted-foreground/30`; working indicator is three staggered pulsing dots + a live "Working for Xs" timer.
- **Markdown pipeline** (`ChatMarkdown.tsx`, 1579 lines): react-markdown + gfm + custom plugins; code blocks get a filename/language header tab (fence meta preserved via custom remark plugin) + Shiki via `@pierre/diffs`' shared highlighter with a **content-hash LRU cache that is bypassed while streaming** (partial fences never pollute the cache) + error-boundary fallback to plain `<pre>`; in-repo file links resolve to open-in-editor with ambiguous-basename disambiguation; tables get scroll+fade+copy-as-markdown/CSV; **copying re-serializes the browser selection back to markdown** instead of trusting `innerText`; typography is a hand-rolled `.chat-markdown` block, not Tailwind `prose`.
- **ContextWindowMeter**: 24px SVG ring, blue→red past 90%, hover popover with tokens + "compacts automatically" note per provider.

### Changed-files card (the H3 reference, "Finale"d 2026-07-20)

- Mounts **under the assistant message of the turn that changed files** (keyed by assistant message id → `TurnDiffSummary`), default-expanded.
- **Sticky header**: "N changed files" + inline `+x −y` + "Collapse/Expand all" + "View diff" button that opens the app diff panel at the first file.
- **Real directory tree** (`turnDiffTree.ts`): groups by path segment, **aggregates +/− up the tree**, **compacts single-child directory chains** (`a/b/c/` renders as one row); folders chevron-rotate, files get file-type sprite icons; per-directory expand overrides reset when Expand/Collapse-all toggles (state key trick).
- **`DiffStatLabel`**: `+N −N` in `text-success`/`text-destructive`, compact-formatted (1.2k), **`grid-cols-[4ch_4ch]` aligned layout** so stats column-align down a file list; zero-stat files stay silent.
- **Expand state persists** per-thread-per-turn in a zustand store debounce-written (500ms) to localStorage; the inner card subscribes directly to the store so toggling re-renders one row, not the list.

### Composer (`ChatComposer.tsx` + `ComposerPromptEditor.tsx`)

- **Canonical state is a plain string.** Lexical (PlainTextPlugin) is only a decoration layer hosting three inline `DecoratorNode` chips (file mention, `$skill`, terminal context); `getTextContent()` of each chip returns real wire text, and the outgoing message is the flat string + appended context blocks. File mentions serialize as markdown links `[label](encodedPath)`; typed `@path` round-trips to the same chip; terminal contexts are a placeholder char expanded at send. Two cursor coordinate systems (chip=1-char "collapsed" vs full-text "expanded") permeate all cursor math — the priced-in cost of inline chips.
- **The slot above the input is a mutually-exclusive priority ladder**: PendingApproval panel > PendingUserInput panel > PlanFollowUp banner — only one renders; while an approval/question is open the **editor itself is repurposed** (value blanked, placeholder = approval detail). Below that, content chips (preview annotations, review comments, element contexts, images) stack above the editor; a separate generic dismissible `ComposerBannerStack` (environment/version) floats above the whole composer — two structurally unrelated systems, don't conflate.
- **Approvals**: `{requestKind: command|file-read|file-change, detail}` rendered **untruncated** in a scrollable `<pre>` (a deliberate 07-20 fix), n/total counter when queued; four buttons: Cancel turn / Decline / Always allow this session / Approve once.
- **Pending questions**: options with number-key shortcuts 1–9, single-select **auto-advances after 200ms**, multi-select requires explicit Next/Submit with an exact label matrix ("Submit answer"/"Submit answers").
- **Send/stop ladder**: pending-answer actions > running→destructive Stop (no queue) > plan Refine/Implement split > send (disabled unless sendable; images-only or context-only sends are valid).
- **Slash/skill/mention menu**: single regex trigger state machine (`/`, `$`, `@`) evaluated per keystroke; built-ins hardcoded (`/model`, `/plan`, `/default` — standalone `/plan` is intercepted as a mode switch, never sent); provider commands+skills are wire-driven with zero client changes; tiered fuzzy scoring; highlight persists only while the query is unchanged.
- **Model picker is keyed by provider *instance*, not driver** (two Codex accounts = two rail entries); favorites, per-row jump shortcuts, disabled-reason tooltips. **Traits (effort/thinking/fast/agent/context-window) are declared by the provider as capability descriptors and rendered generically** — no per-provider UI code; Claude's "ultrathink" is prompt-text-injected (rewrites the prompt, disables the control while the word is present, animates a rainbow `ultrathink-frame`).
- **Draft hero** (new 07-18): empty draft thread renders "What should we build in **{project}**?" with the project name as an inline dotted-underline menu trigger; on first send the hero morphs into the docked composer via the **View Transitions API — mobile only**, reduced-motion-gated; desktop just re-lays-out.
- **Geometry**: `max-w-3xl` centered; `p-px` frame `rounded-[22px]` wrapping `rounded-[20px] border` glass (`color-mix` card at 20%/45% + two-layer shadow); the blur is a **separate sibling backdrop layer** only in docked state, with an `@supports not (backdrop-filter)` flat fallback; footer is a horizontally-scrolling toolbar that collapses into a `⋯` menu below 620/780px, thresholds driven by a **ResizeObserver on the form, not media queries**.

## Target state (glance-desktop, from a same-day code map)

Hub shell (H0) + toolPresenter (H2) merged; `deriveRows.ts` already ports the turn-fold shape; the only raw-JSON remnant is the per-tool expand fold (`TimelineRowView.tsx:174-265`, deliberate). Gaps confirmed live: **no changed-files tree/card** (inline "Changes (N)" accordion of full diffs, `IntervenePane.tsx:413-461`); **scroll ownership implicitly coupled** to IntervenePane's wrapper with only a 40px stick-to-bottom rule; timeline re-derives fresh row objects per 1.5s poll with no structural-sharing pass; `ComposerShell` is send-or-stop with no footer controls (H4 unbuilt); a `timeline/Minimap.tsx` already exists. Diff renderer is the bespoke `diffs/DiffFile` (concern-10 decision: **not** @pierre/diffs) shared by fleet + plan review. Note: the hub-shell H0–H7 concern docs live on **omp-squad main** (`plans/hub-shell/`, PR #211 merged) — the glance-desktop tree has no plans dir, which misled one scout; code comments citing H-numbers are real references.

## Round-3 ranked borrows (against the first-frame/thread-read bottleneck)

1. **The changed-files card recipe — build H3 exactly to this spec.** Sticky "N changed files +x/−y" header with Expand/Collapse-all + View-diff; real path-segment tree with single-child compaction and stat aggregation up the tree; `+N −N` in an aligned `4ch/4ch` grid; per-thread-per-turn expand state persisted (debounced) so re-visits keep your folds; card subscribes to its own store slice so toggles don't re-render the timeline. Where: new `diffs/ChangedFilesCard.tsx` + `fileTree.ts` per H3's TOUCHES, feeding existing `DiffFile` inline. Whole-worktree diff first; per-turn attribution rides H7. This is the pending taste-critical centerpiece and the reference implementation is now fully mapped — including the warning that theirs took 40 days of live use to feel done.
2. **Tool-row and turn-fold deltas — an H2 v2 polish list for the reading surface.** Strip "completed" suffixes; unwrap `bash -lc` wrappers (glance transcripts are full of them); suppress preview text when it duplicates the heading; chevron only when a body exists; failure text-heuristics (exit code/ENOENT) so failed tools read failed without daemon changes; keep subagent/unit rows un-collapsed; zero heading chrome for pure-tool groups; interrupt auto-re-expands the turn; fold duration measured from the user's send. Where: `timeline/toolPresenter.ts`, `deriveRows.ts`, `TimelineRowView.tsx`. Cheap, and it is the surface Lars reads every day (round-2 law 6).
3. **The three-mode scroll model with new-turn anchoring.** Name the modes (`following-end` / `anchoring-new-turn` / `free-scrolling`), and on steer-send pin the user's message near the viewport top with reserved space below so the reply grows downward — the single most felt "modern chat" signature on every send. Fix the implicit scroll-parent coupling (`ConversationView.tsx:104` reads IntervenePane's wrapper) while in there. Port `timelineScrollAnchoring.ts`'s pure math (MIT notice); skip LegendList — their 9-commit scroll saga on a virtualized list is the cautionary tale, and glance's polled transcripts don't need virtualization yet.
4. **The composer pending-slot priority ladder (H4's missing half).** One mutually-exclusive slot above the input consuming the daemon needs-you ladder: approval/gate requests repurpose the editor (blank value, detail as placeholder, untruncated `<pre>` detail), four-decision actions, number-key + 200ms auto-advance for structured questions. glance's server-computed attention ladder (concern 06/07) is *ahead* of t3code here — this is the client-side consumption pattern that makes "the composer is the hub" real. Where: `ComposerShell` header slot + `IntervenePane`, H4's `HubComposerControls`.
5. **The row-stability trio before any timeline polish lands.** Structural-sharing pass over derived rows (reuse unchanged row objects by id), context-not-props for row-shared state, ref-mutated timers + duty-cycled `steps()` pulse keyframes (drop into `t3face.css`). glance re-derives fresh rows every 1.5s poll — without reference stability, row `memo()` is a silent no-op and hover/scroll jank follows. Where: `deriveRows.ts` output, `ConversationView.tsx`, `TimelineRowView.tsx`.
6. **Draft-hero empty state for the hub.** "What should we build in **{project}**?" with the project name as an inline switcher — replaces `EmptyDetail` with the on-ramp gesture, and it's where t3code is investing *this week*. Desktop needs no view-transition (theirs is mobile-only). Where: `spine/FleetLayout.tsx` EmptyDetail path + H1's createConsole.
7. **Descriptor-driven traits as the H7 API shape.** Don't hand-build per-harness model/effort/access UI: have the daemon declare capability descriptors per unit/harness (select/boolean options with values), render controls generically, persist per-thread. Directly informs H7's model/effort/access fields and keeps the cockpit harness-agnostic — same seam philosophy both projects already share.
8. **Small fidelity borrows, batched into concern 11**: copy-handler that re-serializes selection to markdown; code-block filename tabs + streaming-bypassed highlight cache; user-bubble collapse past 600 chars with gradient mask; hover-revealed timestamps/copy; quiet one-line empty states; instance-keyed (not driver-keyed) model identity when H7 lands.

**Build vs buy**: everything above is build — the only dependency decisions are negative: skip `@legendapp/list` (deferred stands), skip `@pierre/diffs` (bespoke `DiffFile` stands, concern-10 decision re-validated), skip Lexical (string-canonical state means the textarea+chip-tray compromise is architecturally aligned with the reference; adopt only the markdown-link mention *serialization format* so prompts stay plain text on the wire).

## Round-3 strategic intel

- **glance's `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` and turn-fold shape match the reference exactly** — the H2/09 work was aimed right; what remains is detail fidelity (borrow 2), not structure.
- **Steer remains the capability lead.** t3code still has no queue and no mid-turn steer (issue #231 open); glance's optimistic clientTurnId steer path is something the reference cannot do. Render it with t3's fidelity and it's a differentiator, not a parity gap.
- **Their perf discipline is the invisible half of "feel".** Half their commits chase the two cursor surfaces, and the architecture (context threading, structural sharing, ref timers, duty-cycled animation) exists to keep typing and scrolling free of jank. A pixel-faithful port without borrow 5 will feel wrong in a way screenshots can't show.
