# Research Brief: cmux → glance/omp-squad

**Date:** 2026-07-06
**Target project:** glance/omp-squad — harness-agnostic autonomous agent fleet (daemon runs units in isolated git worktrees, lands via proven merge; React webapp Fleet Pulse UI; federation; Plane integration; AgentDriver seam over omp/pi/claude-code/codex/opencode/gemini).
**Research target:** [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) — 23.7k★, YC S24 (manaflow), GPL-3.0, created 2026-01-28, extremely active.

---

## Headline correction (both scouts, independently)

The premise "cmux is a container/task-dispatch orchestrator that runs a task N ways and picks a winner" **is false for the current repo**. cmux today is a **native macOS terminal app** (Swift/AppKit on Ghostty's `libghostty` renderer) purpose-built to *supervise many concurrent CLI coding-agent sessions side by side*. Its own tagline: **"cmux is a primitive, not a solution."** It deliberately does **not** own task decomposition, worktree isolation, or merge review — it's the **cockpit**, not the factory.

This is the strategically important fact: cmux and glance are **near-opposite bets**. glance is the opinionated end-to-end autonomous factory (decompose → dispatch → verify → land). cmux is the un-opinionated visibility/ergonomics substrate you drive agents *through*. What people love about cmux is therefore a critique of, and a checklist for, glance's **human-in-the-cockpit** surface — not its autonomy engine.

---

## Scout brief A — architecture (verified against source)

- **What it is:** Ghostty-based macOS terminal with vertical tabs + notifications for AI coding agents. Solves "I have 10 agent panes and macOS's generic notification doesn't tell me *which* one is blocked."
- **Stack:** Swift/AppKit (dominant, ~37MB), Rust multiplexer engine (`mux/` — `mux-core`/`mux-tui`/`ghostty-vt`, session→workspaces→screens→split-tree panes, exposed over a **JSON-Lines Unix-socket control protocol v6**), Go remote daemon (`cmuxd-remote`, tmux-compat, SSH + Cloud-VM attach), Next.js `web/` (marketing + Cloud-VM control plane, Drizzle/Postgres/Effect/Stack Auth), Cloudflare Durable Objects for cross-device presence.
- **Isolation:** *None by default* locally — a "workspace" is a working dir + a tree of panes; whatever isolation exists is whatever the agent CLI does itself. The only provisioned isolation is the paid **Cloud VM** tier (E2B / Freestyle Firecracker microVMs, kill-switched, image-manifest rollback). Plain **SSH** attach for remote.
- **Agent support = hooks, not dispatch:** `CLI/CMUXCLI+AgentHookCatalog.swift` wires each agent's *own* hook system (`SessionStart`/`Stop`/`Notification`/`PreToolUse`/`PostToolUse`/`SubagentStart`…) to `cmux hooks <agent> …`, feeding a session/notification store + event feed. Catalog includes Codex, Grok, OpenCode, **Pi, Omp**, Amp, Cursor, Gemini, Kiro, Antigravity, Rovo Dev, + Claude Code wrapper. Launch plan is just `{provider, executableURL, arguments, environment}` — a wrapped `Process`, no scheduler/queue.
- **"Claude Code Teams" / "oh-my-opencode":** render an agent framework's *native* teammate/subagent fan-out as **visible panes/splits** with sidebar metadata instead of hidden background processes. cmux invents no multi-agent logic; it makes the harness's own fan-out legible.
- **No compare/merge/pick-winner primitive anywhere** in the codebase.
- **Review/diff:** `CmuxGit` gives **read-only** sidebar git/GitHub state (branch, dirty files, linked-PR number+status probe, listening ports, latest notification text). Shiki diff viewer for rendering. **No merge-conflict UI, no built-in land/PR-create** — opening/merging a PR is left to the user's normal workflow.
- **Browser pane:** in-app Chromium via CDP (ported from `vercel-labs/agent-browser`), scriptable so an agent can drive/inspect a dev server in-window.
- **Design decisions:** native over Electron/Tauri for startup speed + memory (explicit); notifications are **protocol-level OSC 9/99/777 + a `cmux notify` CLI** (any terminal program benefits, not just supported agents); everything scriptable over CLI + Unix socket as a substrate for users to build their *own* orchestration.

## Scout brief B — reception (HN, PH, YC, comparisons)

**Most-praised (consensus):**
1. **Notification Rings** — a ring highlights any pane whose agent is *blocked waiting on input*; a panel aggregates them. Quoted everywhere as *the* differentiator: turns "constantly checking panes" into "work on something else, respond when pinged." **This is the single most-cited feature in the entire space.**
2. **Vertical sidebar** showing per-workspace git branch / dir / ports / latest notification — parallel state legible without tab-switching.
3. **Native performance** vs Electron competitors (WaveTerm named as "laggy").
4. Subagents render as **native panes**, not hidden processes.
5. Scriptable in-terminal **browser**.

**Complaints:** macOS-only (loudest, universal); no session restore at launch (tmux wins on persistence + cross-platform); early bugginess (tab hangs, unselectable tabs, search palette Enter dead, multi-monitor breakage); Cloud VM tier flaky (502s, websocket PTY failures — newer/less solid than local core); smaller ecosystem than tmux.

**Category framing — two camps:**
- **Cockpit / visibility layer** (cmux, WaveTerm): *how do I see N agents and know when to intervene.* cmux's home.
- **Orchestrator / isolation layer** (Vibe Kanban, Claude Squad, Conductor, Crystal→Nimbalyst, Sculptor, Terragon): kanban, worktree/container isolation, task decomposition, merge-conflict handling, cloud sandbox. **glance lives here.**

**Adjacent-tool feature signal (the category-leading set):**
- **Claude Squad** — TUI, worktree+tmux isolation, *6 sessions in <5s*, "fast enough I stopped thinking about them."
- **Vibe Kanban** — kanban + MCP-driven auto task decomposition, inline diff review + PR creation from web UI.
- **Conductor** (closed Mac app) — one worktree workspace per agent, fast local review.
- **Crystal→Nimbalyst** — cross-platform + iOS companion, kanban of worktree sessions, 7+ embedded editors.
- **Sculptor (Imbue)** — container isolation per agent, **"Pairing Mode"** to hop live into a running agent's env, **automatic merge-conflict flagging** on merge-back.
- **Terragon/Terry** (shut down, OSS snapshot) — fully cloud/sandboxed, isolated container+repo per task, auto branch+AI commit/PR, `terry` CLI for local takeover of a cloud task; a user ran ~30 tasks/day.

**Bottom line (scout B):** the two axes users pay attention with are (1) **legibility of parallel state without babysitting** (cmux's rings) and (2) **isolation + friction-free merge-back** (Sculptor/Conductor/Squad). Best-in-category needs both, and must not repeat cmux's platform lock-in.

---

## DISSECT — concept extraction

| Concept | How cmux does it | Transferable to glance? | Why / why not |
|---|---|---|---|
| **Blocked-agent ring** (push, not poll) | OS-level ring on the pane that is waiting on human input; aggregated panel | **Yes — highest value** | glance has an `AttentionPanel`/`insights.ts` "Needs you" queue, but it's a *pull* dashboard you must look at. The praised property is *ambient push the instant an agent blocks*. Gap is delivery mechanism + latency, not concept. |
| **Protocol-level notify** (`cmux notify`, OSC 9/99/777) | Any program can raise a notification via escape codes / a tiny CLI, harness-agnostic | **Yes** | Matches glance's AgentDriver seam philosophy exactly — a harness-agnostic `glance notify` / attention event any unit (any harness) can emit, vs. glance inferring attention only from what it can parse. |
| **"Primitive not solution"** stance | Ships substrate (panes/notify/browser/CLI/socket), refuses to prescribe workflow | **Partial — as a tension to resolve, not adopt** | glance's whole bet is the *opposite* (opinionated autonomy). But the critique lands: glance is weak exactly where cmux is strong — the *manual cockpit* for when you want to watch/steer, not just trust. glance needs a first-class "cockpit mode," not to abandon autonomy. |
| **Subagent/teammate as visible pane** | Native fan-out surfaced as panes+sidebar metadata, not hidden processes | **Yes** | glance runs nested/subagents and workflow inner-harnesses; surfacing them as first-class legible nodes (it has `TopologyPanel`, nested-agent tree work) beats burying them. Confirms the direction glance's meta-harness dashboard already took. |
| **Read-only git+PR probe in sidebar** | Branch, dirty files, **linked-PR number+status**, ports, latest notification per workspace | **Yes** | glance lands via PRs but the fleet view should show *per-unit* live PR status/number/CI at a glance. Partially present (land state); PR-number+CI probe is the gap. |
| **Scriptable in-terminal browser** (CDP) | Agent drives/inspects a dev server in the same window | **Maybe** | glance has `agent-browser` skill available; an in-webapp preview/inspect pane for a unit's running dev server is a plausible verification surface, but heavy. Lower priority. |
| **Unix-socket control protocol** as public substrate | JSONL socket: create workspace, split, send keys, drive browser | **Reinforces existing** | glance already exposes WS/POST/federation with Schema validation. Lesson: keep the control surface scriptable/documented as a product, not an internal detail. |
| **Live takeover / Pairing Mode** (Sculptor, `terry`) | Human hops *into* a running agent's live environment to steer | **Yes — big gap** | glance's known weakness ("no steering lane" — see [[glance-vs-direct-diagnosis]]). Attach-to-running-unit (its worktree + live context) is the highest-value *orchestrator-camp* borrow, and it's from the neighbors, not cmux. |
| **Auto merge-conflict flagging on merge-back** (Sculptor) | Flags conflicts when merging an agent branch | **Yes** | glance lands via "proven merge" but surfacing *predicted* conflicts before land, per unit, reduces land thrash (see [[omp-squad-fleet-landing-gotchas]]). |
| **Cross-platform + mobile companion** (Crystal, cmux iOS) | Desktop all-OS + paired phone remote-control | **Partial** | glance is already a web app (cross-platform by construction — an *advantage* over cmux). A mobile-legible "who needs me" push view is the transferable slice. |

---

## ABSTRACT — ranked patterns for glance

### 1. Push-based blocked-agent attention (the cmux ring, done right)
- **Pattern:** the instant any unit blocks on a human (approval, question, ambiguous gate, stuck/verify-thrash), an *ambient push* fires — not a number that changes on a dashboard you have to be looking at.
- **Mechanism:** a harness-agnostic attention event (see #2) → webapp toast/badge + browser Notification API + optional OS/mobile push; the `AttentionPanel` becomes the *log*, the push is the *interrupt*. Rank the queue by "blocked-longest" (cmux sidebar shows latest-notification text; glance already has `insights.ts` ranking).
- **Value for glance:** directly closes the "no steering lane / can't tell who needs me" gap ([[glance-vs-direct-diagnosis]], [[omp-squad-ui-trust-legibility]]). This is the #1 most-loved feature in the entire category and glance is one delivery-layer away from it.
- **Where:** `webapp/src/components/AttentionPanel.tsx`, `webapp/src/lib/insights.ts`, `webapp/src/components/GlobalShortcuts.tsx` (for a jump-to-blocked keybind), a new push channel; TUI `src/web/index.html` fallback.
- **Build vs buy:** build — it's glance-native surfacing over data glance already computes.

### 2. Harness-agnostic `glance notify` / attention primitive
- **Pattern:** any unit on any harness can *explicitly* raise "I need a human, here's why" via one CLI/protocol call, instead of glance only *inferring* attention from parseable gate output.
- **Mechanism:** mirror cmux's OSC/`cmux notify` — a tiny `glance notify --reason … --blocking` that any harness's hook (`Stop`/`Notification`/`UserPromptSubmit`) can call, landing as a structured attention event on the wire (glance already validates `ClientCommand`/`FederationFrame` via Effect Schema — add an `AttentionEvent` kind, see [[omp-squad-effect-setup]]).
- **Value:** works uniformly across omp/pi/claude-code/codex/opencode/gemini via each harness's own hook system — exactly the AgentDriver seam philosophy ([[omp-squad-harness-agnostic]]). Turns attention from "best-effort parse" into "agent-declared signal."
- **Where:** harness registry / `src/agent-driver.ts` + per-harness hook installers; wire schema in the Effect validation layer.
- **Build vs buy:** build.

### 3. First-class "cockpit mode" — the deliberate answer to "primitive not solution"
- **Pattern:** a legible, low-latency *watch-and-steer* surface for the human who wants to supervise rather than trust-and-walk-away — cmux's entire value proposition, which glance's autonomy-first bet under-serves.
- **Mechanism:** per-unit live view = current activity + branch + **linked-PR number/CI status** + ports + last action + one-key **attach/steer** (see #4) and **land/verify**. glance has the panels (`AgentStatusStrip`, `FleetHealthPanel`, `TopologyPanel`, `ActiveWorkPane`) — the gap is composing them into one dense, push-driven cockpit and adding the missing PR-status+CI probe (cmux's `WorkspacePullRequestCandidate`/`GitHubPullRequestProbe` equivalent).
- **Value:** answers the strongest external critique (glance lies / can't steer / context-poor units, [[glance-vs-direct-diagnosis]]) with the market's proven UX.
- **Where:** `webapp/src/components/` cockpit composition + a per-unit PR/CI probe in the daemon's git metadata path.
- **Build vs buy:** build; the *feature set* is borrowed from cmux+Sculptor+Conductor.

### 4. Live takeover / attach-to-running-unit (from Sculptor/Terry, not cmux)
- **Pattern:** hop into a running unit's live worktree + context to steer or rescue it, then release it back to autonomy.
- **Mechanism:** each glance unit already runs in an isolated worktree ([[omp-squad-harness-agnostic]]); expose "open a terminal/session attached to this unit's worktree + running harness" and a "send a steering message into its live context" path (glance has an assistant/message lane; extend to live units).
- **Value:** the single highest-value *orchestrator-camp* borrow; converts glance from fire-and-forget to fire-and-supervise. Highest effort of the four.
- **Where:** daemon session/worktree layer + `webapp` unit detail; overlaps deferred "workflow inner-harness" + steering-lane work.
- **Build vs buy:** build.

### 5. (Lower) Per-unit predicted merge-conflict flag; scriptable preview browser pane
- Conflict pre-flag before land (Sculptor) reduces land thrash ([[omp-squad-fleet-landing-gotchas]]). In-webapp dev-server preview pane (cmux browser) is a plausible but heavy verification surface. Both defer behind 1–4.

---

## Net strategic read

cmux validates that glance's **biggest un-owned surface is the human cockpit**, and that the market's most-loved single feature — *ambient "who needs me right now" without babysitting* — is something glance is **one delivery-layer away from**, because it already computes the attention data (`insights.ts`/`AttentionPanel`) and already has the harness-agnostic seam to source it uniformly. Borrow the *pattern* (push notify + cockpit legibility + live takeover), not the dependency (a macOS terminal). glance's web-app form is a structural *advantage* over cmux's macOS lock-in — its loudest complaint. Don't adopt cmux's "primitive not solution" stance; adopt its *ergonomics* on top of glance's autonomy.

**Do NOT borrow:** container-per-agent-as-only-isolation (glance's worktree model is fine), the tmux/PTY multiplexer engine, or the "we refuse to prescribe a workflow" positioning.
