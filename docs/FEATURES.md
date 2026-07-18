# Glance — Feature Catalog by Access Point

A canonical inventory of everything Glance (formerly omp-squad) exposes, organized by
the surface you reach it through. Every entry is grounded in code, not roadmap intent;
where something is a stub, flag-gated, or unverified, it says so.

**Access points covered:** CLI · Backend HTTP/WS API · Web UI · Desktop app (Tauri) ·
Terminal UI (TUI) · MCP host tools · Harness/ACP integration · Voice · Automation loops ·
External integration surfaces (Plane, federation, push, hooks).

One daemon is the hub. The CLI, web UI, desktop app, TUI, and voice lane are all clients
of the same daemon and its HTTP/WS API; the automation loops and MCP host tools live
*inside* the daemon. Auth has two modes throughout: **file mode** (`?token=` bearer, tiers
admin/operator/viewer) and **DB mode** (better-auth cookie sessions + orgs).

---

## 1. Access points at a glance

| Access point | Entry | What it's for |
|---|---|---|
| **CLI** | `glance` / `omp-squad` → `src/index.ts` | Start the daemon; drive the fleet from a terminal (mostly a thin HTTP client). |
| **Backend API** | `src/server.ts` (HTTP + one WS) | The daemon's REST/WS surface every other client speaks to. |
| **Web UI** | React app in `webapp/` (`GLANCE_WEBAPP=1`) | The full-fidelity browser cockpit. |
| **Desktop app** | Tauri app at `../glance-desktop` | Native ADE (terminal/editor/AI) + fleet cockpit connecting to daemons. |
| **TUI** | `src/tui.ts` (in-process, launched by `glance up`) | Terminal dashboard bound directly to the manager. |
| **MCP host tools** | `SQUAD_HOST_TOOLS` via `set_host_tools` | Tools the daemon exposes *to* the agents it runs. |
| **Harness/ACP** | `src/harness-registry.ts` | Run any coding agent (omp/pi/claude-code/grok/…) behind one seam. |
| **Voice** | `src/voice-token.ts` + `webapp/src/lib/voice/` | Hands-free spoken control of the fleet (WebRTC S2S). |
| **Automation** | `SquadManager.start()` loops | Autonomous background work (dispatch/land/scout/…). |
| **Integrations** | Plane, federation, web-push, git/omp hooks | Ticket pipeline, cross-operator sync, notifications, presence. |

---

## 2. Cross-cutting capability matrix

Where the same capability shows up across surfaces. ✓ = present, ◐ = partial/limited,
· = not available.

| Capability | CLI | API | Web | Desktop | TUI | Voice |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Spawn an agent / unit | ✓ | ✓ | ✓ | ◐¹ | ✓ | ✓ |
| View roster | ✓ | ✓ | ✓ | ✓ | ✓ | ◐² |
| Send prompt / steer a unit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read transcript | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| View diff / changed files | · | ✓ | ✓ | ✓ | · | · |
| Land / verify / promote | ✓³ | ✓ | ✓ | ◐⁴ | ◐⁵ | · |
| Intervene / take-over | · | ✓ | ✓ | ✓ | ◐⁵ | ◐⁶ |
| Kill / restart / remove | ✓ | ✓ | ✓ | ◐ | ✓ | · |
| Log friction ("grr") | ✓ | ✓ | ✓ | · | ✓ | · |
| Adopt ad-hoc CLI sessions | · | ✓ | ✓ | ✓ | · | · |
| Doctor / factory diagnostics | ✓ | ✓ | ✓ | · | · | · |
| Planning (validate/decompose/promote) | ✓ | ✓ | ✓ | · | · | · |
| Fleet-status readout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

¹ Desktop spawns via daemon console/promote flows, not a raw "add". ² Voice `fleet_status`
is read-only. ³ CLI `land` is via `/api/agents/:id/land`. ⁴ Desktop surfaces land controls
through the daemon; primary landing UX is web. ⁵ TUI slash verbs stop/restart/kill; land
authority is shown but landing is orchestrator/web-driven. ⁶ Voice `interrupt` only.

---

## 3. CLI

Entry: `src/index.ts` `main()` switch. `bin`: `glance` and `omp-squad`. Global flags
(`--port`, `--host`, `--no-supervise`) via `src/cli-args.ts`. Most verbs are thin HTTP
clients against a running daemon; `up`, `here`, `plan-validate`, `plan-decompose`, `who`,
and `curate-plane` do real local work.

### Daemon / server control
- **`glance up`** *(also the no-arg default)* — Start the long-lived daemon (HTTP server + optional TUI) that owns all agents. Flags: `--port N`, `--host addr`, `--no-tui`, `--restore` (reload persisted agents, file mode), `--no-supervise`. Handles file vs DB mode, TLS gating, root-factory opt-in, single-writer state lock.
- **`glance here [prompt]`** — Attach an interactive chat REPL to an agent on the current git dir, in this terminal (auto-boots a daemon if none reachable). Flags: `--web`, `--model`, `--harness`, `--port`.
- **`glance open <id|name|branch>`** — Resolve a unit's worktree and open it in the local editor (`OMP_SQUAD_OPEN_CMD`, else terax/code), falling back to printing the path.

### Fleet / dispatch (agent lifecycle)
- **`glance add <repo>`** — Spawn an agent in a new git worktree. Flags: `--name`, `--branch`, `--model`, `--approval` (always-ask|write|yolo), `--thinking`, `--task`, `--workflow`, `--verify <cmd>`, `--lane` (hotfix|feature|chore), `--sandbox <image>`, `--acp`/`--runtime acp`, `--harness`, `--bin`, `--profile`, `--plain`.
- **`glance list` / `ls`** — Agent roster. `--json`.
- **`glance prompt <id> <msg…>` / `say`** — Send an instruction to a running agent.
- **`glance notify <id> <summary…>`** — Raise non-blocking human-attention on a unit. `--detail`.
- **`glance kill <id>` / `stop`** — Stop an agent, keep it in the roster.
- **`glance rm <id>` / `remove`** — Remove an agent. `--delete-worktree`.
- **`glance logs <id>`** — Recent transcript. `--limit N` (default 40).
- **`glance who [repo]`** — Who/what (any omp agent, squad or raw) is working a repo, or all active agents.
- **`glance harnesses`** — Honest capability-tier matrix for every registered harness (verified/detected/registered, usage-verified bit, missing-binary alerts). `--json`.
- **`glance commission <name>` / `hire`** — Author + validate + onboard a purpose-built "flue-service" worker. Flags: `--purpose` (required), `--model`, `--target node|cloudflare`, `--capabilities`, `--accept-payload`, `--accept-expect`.

### Planning
- **`glance plan-validate <dir>` / `validate-plan`** — Offline: check a plan dir's dependency graph for cycles/dangling deps (no daemon). Exit 1 on issues. `--json`.
- **`glance plan-decompose <dir>`** — One-shot: decompose `<dir>/OBJECTIVE.md` into a concern-DAG and write concern drafts (needs `omp`). `--json`.
- **`glance promote <issue>`** — Enrich a Backlog Plane ticket with Tier-1/Tier-2 context (never changes ticket state). Flags: `--repo`, `--json`.
- **`glance curate-plane [repo]` / `plane-curator`** — Group recurring Plane issues into unified fixes. `--file` files one `[curator]` issue per cluster.

### Ask / answers
- **`glance ask "<question>"`** — Ask a question; the deliverable is a written answer, not a branch (observer unit, cannot mutate repo). Waits by default. Flags: `--repo`, `--model`, `--harness`, `--json`, `--no-wait`, `--read <id>`.
- **`glance answers [<id>]`** — List durable answers, or print one. `--repo`, `--json`.

### Diagnostics
- **`glance doctor`** — Diagnose the factory: on, armed, pointed at the right world? Exit code = verdict. `--json`.
- **`glance symptom "<query>"`** — Search the recorded symptom-card index, flagging dead `whereToLook` pointers. `--repo`, `--json`.

### Automation / observability
- **`glance automation` / `auto`** — What the daemon's background loops are doing + Scout LLM cost. Flags: `--window`, `--loop`, `--limit`, `--json`.

### Adoption / dogfood
- **`glance grr "<gripe>"`** — Log a friction gripe to the dogfood ledger in <5s. Flags: `--repo`, `--context`. List mode: `glance grr --list`.

### Hooks / help
- **`glance install-hooks --harness`** — Register lifecycle hooks in verified foreign harnesses (claude/codex) so raw sessions report into `glance who`. `--uninstall`, `--port`.
- **`glance help` / `-h` / `--help`** — Usage. Unknown command prints help, exits 1.

### Internal entrypoints (run via `bun src/<file>`, not `glance` verbs)
- **`agent-host-main.ts`** — Detached agent-host process launched by `RpcAgent`.
- **`coordinator-main.ts`** — Federation coordinator relay (loopback-only by default).
- **`federation-sync-main.ts`** — Standalone cross-host git-lease sync process.

---

## 4. Backend HTTP / WS API

Source: `src/server.ts` (`SquadServer.handle` / `handleObservability`) + `src/feedback-routes.ts`.
Routing is `if pathname === … && method === …` plus regex matches. Per-route minimum tier
via `requiredRole`. DB-mode non-GET mutations are origin-checked. Unmatched → `404`.

### Realtime (WebSocket — there are no SSE endpoints)
- **WS `/ws`** — The single realtime bridge. Emits a `roster` snapshot on connect, then streams `SquadEvent`s (agent/removed/roster/alerts); client→server sends `ClientCommand`. Viewers may connect read-only; per-command tier checks in `applyCommand`. DB mode fans out per-org.

### Static / PWA (public bootstrap)
- **GET `/`, `/index.html`** — SPA shell. **GET `/assets/*`** — content-hashed Vite bundle (traversal-guarded). **`/manifest.webmanifest`, `/sw.js`, `/icon*.png|svg`** — PWA install assets. **GET `/favicon.ico`** — 204. **GET `/feedback/widget.js`** — embeddable feedback widget. **GET `/llms.txt`** — plaintext capability manifest. **GET `/openapi.json`** — minimal OpenAPI 3.1 for the capability API.

### Health / doctor / factory
- **GET `/api/health`** · **`/api/doctor`** (host visibility, autonomy) · **`/api/factory/status`** (per-loop liveness: moving|idle|not-armed|off) · **`/api/version`** · **`/api/info`** (`{cwd}`).

### Auth / identity / WorkOS
- **ALL `/api/auth/*`** (better-auth: sign-in/up, session, social, SSO — DB mode) · **GET `/api/auth/mode`** (file vs db, signup/social/SSO — public) · **`/api/auth/check`** · **GET `/api/me`** · **POST `/api/workos/webhook`** (signature-verified, public) · **POST `/api/workos/sync`** · **GET `/api/workos/join-requests`** · **POST `/api/workos/join-requests/decide`**.

### Org admin (DB mode)
- **GET/PATCH `/api/org`** · **GET `/api/org/members`** · **POST `/api/org/members/{role,remove,invite}`** · **GET/POST `/api/org/join-policy`** · **GET `/api/org/voice`** · **PUT/DELETE `/api/org/voice-key`** · **POST `/api/org/voice/enabled`**.

### Voice
- **GET `/api/voice/config`** (gated by `OMP_SQUAD_VOICE_ENABLED`) · **POST `/api/voice/token`** — mint an ephemeral WebRTC voice token scoped to the org's own key (reserves a concurrency slot before minting).

### Agents (roster / lifecycle / control)
- Reads: **GET `/api/agents`**, **`/api/agents/:id`**, `/transcript`, `/transitions`, `/subagents`, `/receipts`, `/checkpoints`, `/commands`, `/diff`, `/tree`.
- Actions: **POST** `/api/agents/:id/` → `land`, `open`, `apply-held-sync`, `discard-held-sync`, `ack-boundary-sync-divergence`, `verify`, `mode`, `promote`, `vision` (SSRF-checked).
- Fleet: **POST `/api/agents/adopt`** · **POST `/api/spawn`** · **POST `/api/console`** (steer) · **POST `/api/console/release`** · **POST `/api/command`** (generic ClientCommand: create/commission/kill/restart/remove) · **GET `/api/boundary-sync/orphaned`**.

### Tasks (Plane-backed)
- **GET `/api/plane/issues`** (501 if Plane unconfigured) · **POST `/api/tasks/:id/start`** · **GET `/api/tasks/:id`** · **POST `/api/issues/:id/promote`** (Tier-1/Tier-2 enrichment, ask-mode).

### Features / plans / landing
- CRUD: **GET/POST `/api/features`**, **`/api/features/archived`**, **`/from-plan`**, **`/auto`**, **PATCH/DELETE `/api/features/:id`**.
- Assignees & voting: **GET/PUT `/:id/assignees`** · **POST `/:id/plan-vote/{call,cast}`** · **GET `/:id/plan-vote`**.
- Agents & concerns: **POST `/:id/agents`** · **PATCH `/:id/concerns`** · **POST `/:id/answers`** · **POST `/:id/land`** · **POST `/:id/verify`**.
- Plane linkage: **GET `/:id/tickets`** · **POST `/:id/module`** · **POST `/:id/module/repair`** · **GET `/:id/pipeline`** · **GET `/:id/done-proof`**.
- Plan candidates: **GET/POST `/:id/plan-candidates`** · **POST `/:id/plan-candidates/:cid/{accept,reject,supersede}`**.
- Annotations: **GET/POST `/:id/annotations`** · **POST `/:id/annotations/:aid/{resolve,send}`**.
- Plan docs: **GET `/api/plan-doc`** · **GET `/api/plan-doc/diff`**.

### Comments
- **GET/POST `/api/comments`** · **POST `/api/comments/:id/resolve`**.

### Fabric / context / graph / observability (GET; break-glass-unioned for bootstrap admin)
- **GET `/api/fabric`** (agents/digests/hotAreas/scout/leases/decisions) · **`/api/fabric/search`** (BM25, `?q=&topK=&type=`).
- Graph: **GET `/api/graph`**, `/commit`, `/attribution`, `/scoreboard`, `/provenance`, `/task-class`.
- Metrics: **GET `/api/usage`**, `/api/heat`, `/api/activity/heatmap`, `/api/action-items`, `/api/governance`, `/api/audit`, `/api/automation`, `/api/metrics/learning-loop`.
- Knowledge: **GET `/api/trace/:id`**, `/api/digest/:id`, `/api/fog`, `/api/episodes[/:id]`, `/api/symptoms`, `/api/answers[/:id]` + **POST `/api/answers`**, `/api/opportunities`.

### Attention / adoption / friction
- **GET/POST `/api/attention`** · **GET `/api/attention/seen`** · **GET `/api/adoption`** · **GET/POST `/api/friction`** · **POST `/api/push-tap`**.

### Presence / leases / harness events
- **GET `/api/presence`** · **GET/POST/DELETE `/api/leases`** (`?repo=`) · **POST `/api/harness-events`** (ingest harness-hook events, returns a decision).

### Projects / config / policy / settings
- **GET/POST/DELETE `/api/projects`** · **GET `/api/workflows`** · **`/api/models`** · **`/api/profiles`** · **`/api/harnesses`** · **GET `/api/settings`** · **POST `/api/settings/feature-flags`** · **GET/POST `/api/policy/rules`**.

### Capabilities / federation
- **GET `/api/capabilities`**, `/capability-audit`, `/capability-verifications`, `/capability-catalog`, `/capability-discovery`, `/capability-sources` (+ **POST**), `/capability-packs[/:id[/diff/:version]]`, `/capability-installs` (+ **POST**, **PATCH `/:id`**, **POST `/:id/run`**).
- **GET `/api/federation`** · **POST `/api/federation/command`** · **GET `/api/federation/capabilities`**.

### Upgrade / push / attachments / feedback
- **GET `/api/upgrade/status`** · **POST `/api/upgrade`** (admin).
- **GET `/api/push/key`** (VAPID) · **POST `/api/push/subscribe`**.
- **POST `/api/chat-attachments`** (quota/dimension enforced) · **GET `/api/chat-attachments/:id`**.
- **POST `/api/feedback/items`** (public widget intake; campaign-token + origin + byte-cap) · **GET `/api/feedback/items[/:id]`** · **POST `/api/feedback/items/:id/validate`** · **POST `/api/feedback/items/:id/reward/{approve,void,mark-paid}`** · **GET/POST `/api/feedback/campaigns`**.

---

## 5. Web UI

Source: `webapp/src/`. `App.tsx` gates on auth, then routes an `AppView` union
(`fleet · tasks · omp-graph · fog · capabilities · org · intervene · review`) into one
main slot, with the left `WorkbenchPane`, top `FactoryStatusStrip`, and floating
chat/palette/HUD around it. (`src/web/index.html` is the legacy fallback; the React app is
the live UI under `GLANCE_WEBAPP=1`.) Live data rides the `/ws` WebSocket.

### Navigation / shell
- **Left nav rail** — switch the five primary views (Fleet · Tasks · Graph · Fog · Capabilities), collapse/expand, reach Org via the gear.
- **Task rail** — search by title/ID, filter by status/category, drill in, add task/project; **voice-to-task dictation** (mic → new task via browser STT).
- **Archived "garbage bin"** — restore or hard-delete archived features.
- **Account menu** — identity/role, background-push toggle, admin join-requests, sign out.
- **Command palette (⌘K)** — jump to any view, focus search, run Fabric/KB search from anywhere.
- **Global shortcuts**, **dark/light theme** (persisted), **Agent FAB** (opens chat anywhere), **toasts**, dev-only **page-context debug panel** (⌃⇧D).

### Task & agent views
- **Task list board** — dense Pinned→In-Progress→Planned→Done rows; inline status/pin, progress %, assigned agents.
- **Category Canvas (LIST|CANVAS toggle)** — radial constellation of categories sized by open work; zoom into a category's plans.
- **Task detail** — plan markdown, verdict-first status strip, agents/sessions/artifacts in one pane.
- **Agent status strip** — "is this okay / does it need me?" + one inline action (answer/restart/staff).
- **Task properties editor** (status/priority/category-with-Auto), **assignees editor** (org-member multi-select, DB mode), **sessions table**, **artifacts rail** (per-doc annotation counts + done-proof), **proof/provenance panel**.
- **Plan annotations / line comments** — highlight a plan quote, comment, send as steering.
- **Checkpoint fork / continue** — fork from a recorded step, or continue a recoverable exhausted run.
- **Agent source / model badges** — which harness/model produced work + model deltas.

### Planning
- **Plan DAG (PlanFlowDiagram)** — concerns as a status-colored dependency graph; click a node to open it; inline-edit STATUS/blockers written back to the doc.
- **Workflow graph overlay** — a run's topology with live progress + per-run trace drill-in (rollup + span waterfall).
- **Rich plan blocks** — Mermaid, hand-drawn wireframes, interactive Questions blocks, callouts, file-tree change lists, two-column layouts, line-annotated code.
- **Design review loop (`/review/:taskId`)** — plan doc + comments rail, "N/M resolved" progress, assignee votes on revision candidates, "changed since your last view" diff, "ready to implement" gate.

### Landing / diff
- **Diff review panel** — collapsible per-file changed-files with raw diffs in chat/transcript.
- **Land / verify controls** — validation + confidence badges, land/verify/promote buttons on an agent.
- **Diff ordering & stats** — order diffs, show add/remove line stats.
- **Commit diff drill-in** — click a commit milestone in the graph for a GitHub-style diff.

### Chat & voice
- **Assistant chat** — resizable side panel, persisted multi-session history, new/delete session, transcript download.
- **Composer** — `@`-mention menu, model picker, draft persistence; **friction "grr" button**; **speech-to-text mic** (dictate into draft).
- **Image attach / capture / annotate** — attach/paste images, "Capture view" snapshot, box/pin annotations flattened into the sent PNG.
- **Spawn-a-unit flow** — turn an annotated capture into a real unit, gated by an editable confirm sheet, with a spawned-unit status card.
- **Transcript timeline** — streaming transcript, grouped tool-call rows, collapsible Todo panel; **suggestion chips**.
- **Live voice call** — metered provider-direct S2S call with a floating in-call HUD (state, elapsed, cost estimate, push-to-talk, hang-up) that survives view/chat changes.

### Intervention / steering
- **Intervene view** — the "Needs you" step-in surface: what an agent is doing, why it stopped, what it changed, the single resolving action, step back out.
- **Line-level diff correction** — annotate the exact wrong changed line and have the agent redo it.
- **Gate / pending-answer widget** — answer a blocking question via preset buttons or free text.
- **Agent control** — interrupt, stop, restart, steer, fork, continue, set model, answer, remove.
- **Diff-viewed / attention reporting** — clears attention items when you've reviewed a PR/diff.

### Observability / dashboards
- **Fleet cockpit (WorkspaceCockpit)** — roster grouped Needs-You · Land-Ready · Working · Idle/Done · Unstaffed-Plans, with inline answering, transcript+composer to steer any unit, land rail, capacity/activity header, push toggle.
- **Fleet pulse graph (OmpGraphPanel)** — living temporal dashboard (commits/cost over 7/14/30-day + weekly windows), flat vs depth viz, drag-back history, collision detection, click-through inspector.
- **Comprehension fog (FogView)** — folder/file heat tree surfacing comprehension debt (never-seen / seen-current / stale).
- **Factory status strip** — always-visible fleet-liveness banner (moving / idle / not-armed / off) with heartbeat dots, land-blocker line, capacity chip.
- **Capabilities panel** — browse capability packs, install/enable/disable/run tools, skills, workflows, with per-pack health.

### Settings / admin / onboarding
- **Org settings** — rename org, manage members, invite by email+role, set join policy (auto/approval), configure org voice key (set/delete/enable).
- **Join-request approvals** (admin), **first-run setup** (register first project), **sign-in screens** (WorkOS/GitHub/email in DB mode; file-mode bearer token; pending-approval holding screen).

### Adoption / on-ramp / friction
- **Adopt ad-hoc CLI sessions** — presence detects raw `claude`/`omp`/`glance here` sessions and offers one-click "Adopt" into a gated unit.
- **Promote a console chat to a working unit** · **boundary sync** (one-click apply of a `glance here` session's held turn).

### PWA / notifications
- **Background web push** — service-worker + VAPID subscription, enabled via account menu or cockpit.
- **Push-tap adoption beacon** — reports app opens from a push tap.

---

## 6. Desktop app (Tauri)

A Tauri 2 + Rust + React 19 app at `../glance-desktop` (bundle `app.glance.desktop`), a hard
fork of terax-ai rebranded to Glance. The inherited terminal/editor/AI stack is the *host
shell*; the fleet module + daemon-backed chat is the *desktop-unique* layer. It connects to
one or more **glance daemons** over loopback HTTP (CSP forbids `ws://`, so it **polls**).

### Native shell / OS integration (`src-tauri/`)
- **Two-process model** — webview → `invoke()` → Rust commands; no OS access from the webview.
- **Native PTY** — interactive shells via `portable-pty` streamed to xterm; Windows Job Objects kill orphaned trees.
- **Filesystem** — read/write/stat, create/rename/delete/copy, dir tree, fuzzy search, ripgrep grep+glob, FS watcher.
- **Git** — status/diff/stage/commit/fetch/pull(ff)/push/log/show/branch/checkout, workspace-authorized.
- **Shell** — one-shot, persistent sessions, and background dev-server shells with ring-buffer logs.
- **LSP host** — spawn/send/kill language servers as JSON-RPC pipes.
- **AI HTTP proxy with SSRF guard** — keeps provider calls off the webview.
- **OS keychain secrets** — API keys + daemon tokens via `keyring` (service `glance-ai`), Linux file-fallback.
- **Shell history**, **workspace + WSL bridge** (`wsl_list_distros`/`wsl_home`), **agent hook installation** (writes Claude/Codex/Gemini CLI hook config for OSC markers).
- **Native notifications**, **auto-updater** (minisign, GitHub releases endpoint), **autostart / launch-at-login**, **window-state persistence**, clipboard/opener/os/process/log plugins.
- **CLI / "Open With" launch handling**, **file associations** (~80 extensions), cross-platform bundling (macOS/Linux/Windows), plugin-scoped **capabilities allowlist**, **no telemetry / no account**.

### Windows
- **Single main window** (starts hidden, shown after first paint to avoid flash).
- **Separate Settings window** (`open_settings_window(tab)`, deep-linkable, lifecycle tied to main).
- **Custom window chrome** (Linux/Windows CSD; macOS native traffic lights), external-URL child webview.

### Fleet cockpit (`src/modules/fleet/`) — desktop-unique
- **Fleet tab** (`kind:"fleet"`) + command-palette "New fleet pane".
- **Connection-state pane** (idle/connecting/unauthorized/unreachable with Retry + Fleet-settings deep-link).
- **Live roster** (polls `/api/agents` every 2s: status dot, repo·branch, harness badge, per-turn cost, "Needs you" section).
- **Multi-daemon roster merge** — units from several daemons in one roster with host/daemon badges; a failing daemon degrades only its own rows.
- **Unit intervene detail** — "why it stopped" banner, collapsible per-file diff, live ACP conversation, steer composer.
- **Steer a unit** (turn into the ACP session via `POST /api/command`, never keystroke injection).
- **Live conversation view** (polled transcript deltas, auto-scroll).
- **Take over / hand back** — quiesce an agent so the human drives the worktree, then restore + resume.
- **Workspace/leases overlay** ("Working here": who holds which file).
- **Adoptable ad-hoc sessions** — polls presence for raw CLI sessions, offers "Adopt".
- **Open worktree as a Space** (loopback daemons only), **native attention notifications** (click focuses the exact unit), fleet-selection store.

### Daemon-backed chat / escalation (`src/modules/ai/`) — desktop-unique
- **Local vs Daemon chat toggle** — run the composer against BYOK locally, or as a glance daemon console unit.
- **Daemon chat transport** (lazily creates `/api/console` unit, streams by polling transcript deltas).
- **Promote chat to a working unit** (in place, keeps conversation + worktree, opens as a Space).

### Daemon connection & settings
- **Typed daemon REST client** (`fleetClient.ts`) — loopback fetch; auth probe via `/api/auth/check`.
- **Multi-daemon connection management** — add/edit/remove/set-active, per-daemon Test probe, legacy single-daemon migration, default `http://127.0.0.1:7878`.
- **Per-connection token storage** in the OS keychain; self-contained fleet store separate from prefs.
- **Settings sections**: General (autostart), Editor, Themes, Shortcuts, Models (BYOK), Agents (hooks), **Fleet** (connections), About. **Auto-updater UI**.

### Host-shell features (inherited from terax — desktop-only vs the web UI)
- Multi-tab WebGL terminal (split panes, OSC 7/133 integration, agent-signal detection); CodeMirror 6 editor (vim, AI inline autocomplete, format-on-save); file explorer (icon themes, fuzzy nav, inline rename); source-control panel + git-history graph; web preview; AI side-panel (BYOK agent + sub-agents, tool approval, AI edit diffs); command palette; spaces/projects; theme engine (custom themes, background images, t3face skin); sidebar/activity bar; statusbar; notification bell. Tab kinds: terminal/editor/preview/markdown/ai-diff/git-diff/git-history/git-commit-file/**fleet**.

### Shipped vs. deferred
- **Shipped:** all of §6 above (fleet tab, connection layer, multi-daemon roster, intervene/steer/take-over, leases overlay, adopt, worktree-as-Space, native notifications, daemon chat, promote-to-unit, settings Fleet section, inherited shell). Skeleton comments in `FleetPane`/`fleetClient` are stale — the roster + intervene stack are implemented.
- **Deferred/limited:** remote/HTTPS daemon support is minimal (remote worktree-open disabled, token required); push (`ws://`) intentionally avoided in favor of polling; the deep-rename to "Glance" (Rust crate still `terax`, in-app "Ask Terax", `terax-spaces.json`) is deferred to "Epic M".
- `ROADMAP.md` is upstream terax's roadmap, not this fork's plan.

---

## 7. Terminal UI (TUI)

`src/tui.ts` (`SquadTui`) — an interactive terminal dashboard on `@oh-my-pi/pi-tui`, bound
directly to a `SquadManager` in-process (not over HTTP), live-redrawing on manager events.
Launched by `glance up` unless `--no-tui`. (`src/console-prompt.ts` is *not* a TUI — it's the
shared console system-prompt text.)

- **LIST view** — exception-first roster (needs-input → error → veto/held-but-ready → landReady → working → idle → starting → stopped). Rows: status dot/spinner, kind glyph (workflow ⚙, flue-service ⚒), name (fan-out nested under parent), branch, activity/todo/error, badges (`✓LAND`, `⛔VETO`, `⏳HOLD`, `‖HELD`), todo count, context %. Title bar aggregates counts + `[disconnected]`.
- **AGENT view** — transcript + composer. Header: branch · model · ctx% · cost · tokens · 🔧 tool-calls · duration, plus a land/authority header (proof freshness, validator verdict incl. loud VETO, run confidence + propose-only cap, effective mode, ready-to-land / held reason). Renders pending human-input prompts (confirm `[y/n]`, select `[opts]`, input).
- **Keybindings** — `↑/↓` move/scroll · `→` open agent · `←` back · `Enter` spawn (list) / send-or-answer (agent) · `a` jump to next blocked · `Ctrl-G` friction-capture ("grr") mode · `Esc` cancel/back/quit · `Ctrl-C` quit. Slash verbs: `/stop` (`/interrupt`), `/restart`, `/kill`, `/rm`, `/back`, `/grr [text]`.
- **Composer** — full pi-tui `Editor` (multiline, paste, kill-ring, undo, history).
- **Out-of-band attention** — on transition into input/error: terminal bell + OSC 9 / OSC 777 desktop-notify, gated by the same `escalationPayload` as web-push (they can't drift), per-agent throttled. Alt-screen, raw-mode, spinner only while agents work.

---

## 8. MCP host tools (exposed to agents)

The daemon advertises its own host tools to every omp/pi child via `set_host_tools` on ready
(`AgentDriver.setHostTools`, `SQUAD_HOST_TOOLS` in `squad-manager.ts`). This is the channel
the fleet uses to coordinate.

- **`squad_kb_search`** — search the fleet's shared knowledge base (decisions, hot files, digests, latent work, leases, active agents), scoped to what the agent may see. Optional `type` filter + `topK`.
- **`squad_message`** — send a short ADVISORY message to another agent by id/name (appears in their transcript, never interrupts/steers); budget-capped (`OMP_SQUAD_PEERMSG_BUDGET`, default 5).
- **`squad_report`** — raise a proposal / flag uncertainty WITHOUT stopping (non-blocking "Needs you" row).
- **`squad_attention`** — flag that a human should look at something (non-blocking).
- **`squad_record_decision`** — record a consequential decision + rationale (and, with `source:"model-delta"` + `evidence`, a mental-model delta) so future agents inherit it. **Flag-gated: only when `OMP_SQUAD_DECISION_CAPTURE` is on** (default off).
- **`squad_record_symptom`** — record an operator-observable symptom card when this run fixed a defect (`whereToLook` 1–5 paths/commands). **Same gate.**

**Capability caveat:** the host-tool channel exists only for harnesses with `capabilities.hostTools:true` — that is **omp** only. `pi` and every ACP harness have `hostTools:false`, so these tools are unavailable there (documented degradation, not a silent no-op). `src/mcp-config.ts` is the *inverse* surface — MCP servers the daemon *consumes*/injects into a unit's worktree (`.omp/mcp.json` / ACP `session/new`).

---

## 9. Harness / ACP integration ("run any agent behind one seam")

`src/harness-registry.ts` — every non-omp harness translates its native protocol into omp's
event/frame vocabulary. Two wire protocols: **omp-rpc** (LF-JSONL, `RpcAgent`) and **acp**
(Agent Client Protocol, `AcpAgentDriver`). One `AgentDriver` contract programs the manager
(start/stop/detach/prompt/abort/getState/setModel/setThinkingLevel/setHostTools/respondUi/
respondHostTool). Each harness carries a `CapabilityDescriptor` + a `verified` flag
(unverified hidden unless `OMP_SQUAD_UNVERIFIED_HARNESS=1`). Default `omp`, override via
`GLANCE_HARNESS`.

| Harness | Protocol | Launch | Verified | Notes |
|---|---|---|:--:|---|
| **omp** | omp-rpc | `omp` | ✓ | default; full caps, host tools, soft-lease hook, `--approval-mode` |
| **pi** | omp-rpc | `pi --mode rpc` | ✓ | no host-tool channel, no approval primitive (yolo only), no ready frame |
| **claude-code** | acp | `npx @zed-industries/claude-code-acp` | ✓ | third-party ACP adapter over the Claude Agent SDK; uses operator `~/.claude` login |
| **grok** (xAI) | acp | `grok agent stdio` | ✓ | first vendor-pinned verified harness (activates the degradation ladder); cached `~/.grok` |
| **opencode** | acp | `opencode acp` | ✓ | native first-party ACP, handshake live-verified |
| **auggie** (Augment) | acp | `auggie --acp` | ✗ | legacy target |
| **gemini** | acp | `gemini --acp` | ✗ | native first-party ACP, unsmoked |
| **codex** | acp | `npx @agentclientprotocol/codex-acp` | ✗ | adapter mid-migration between orgs |

ACP caps are deliberately conservative (`resumable:false`, `thinking:false`,
`contextInjection:"none"`) because the manager doesn't yet drive `session/load` or an MCP
context server — named gaps, not faked. Also: `harnessTierInfo`/`listHarnessTiers` (honest
tier + binary-on-PATH detection), `harness-scorecard.ts` (advisory 5-dimension scorecard),
`sandbox-agent-driver.ts` (containerized omp child), `acp-orphan-reaper.ts` (boot-time
cleanup of leaked `npx → *-acp` chains).

**Reverse seam** — `src/harness-hooks.ts`: foreign harness CLIs (a human running raw `claude`)
self-report lifecycle to the daemon (`/api/harness-events`, operator-tier localhost) so they
appear in presence/`who` and lease warnings. Only claude-code's hook schema is verified/
installed; codex/gemini are declared unverified and skipped.

---

## 10. Voice (speech-to-speech lane)

**Server** (`src/voice-token.ts`) — mints a short-lived ephemeral token from the voice
provider's mint endpoint using the real provider key (server-only, never sent to the browser);
the browser then connects **directly** to the provider over WebRTC — audio never transits the
daemon. Provider registry is a closed switch (currently only `openai`). Org-aware key
resolution (file-mode env key or DB-mode per-org secret with an `enabled` kill switch); the
server pins all cost-bearing params at mint, with a 120s establishment TTL, a durable per-org
concurrency cap, and a per-actor rate limiter. `GET /api/voice/config` publishes provider info.

**Browser** (`webapp/src/lib/voice/`) — the S2S agent lane: `voiceSession.ts` (WebRTC state
machine: mint → RTCPeerConnection → mic track → `oai-events` data channel → SDP, barge-in/PTT
arbitration), `speech.ts`, `callHud.ts`, `provider.ts`, `tools.ts`. It enables hands-free
spoken control of the fleet. The voice agent has exactly four realtime tools (`VOICE_TOOL_DEFS`):

- **`prompt_agent`** — message the bound console agent.
- **`spawn_agent`** — spawn a unit.
- **`fleet_status`** — read-only (the only tool exempt from the human-turn gate).
- **`interrupt`** — interrupt a unit.

Admin verbs (kill/restart/remove/fork) are deliberately excluded from the schema. Mutating
tools are gated behind a human turn (injection defense) with structured outputs. Voice-sourced
dispatches always arm a completion push.

---

## 11. Automation loops (autonomous, in-daemon)

Owned by `SquadManager.start()`, observed via `src/automation-log.ts` (`/api/automation`).
`src/scheduler.ts` is admission control only (WIP ceiling, host-pressure probe, FIFO park
queue) — not a loop runner. `AutomationLoop` types: `scout | observer | opportunity | dispatch
| scope | plan-sync | resident-planner | sentinel | orphan-audit | land | episode`.

- **Poll** — `POLL_MS` 2500ms; refresh live state, publish presence, drive sub-reapers.
- **Auto-dispatch** — default 60s; pulls Plane issues, spawns units up to `OMP_SQUAD_DISPATCH_MAX` (3)/WIP cap; degradation-ladder aware. Gated `OMP_SQUAD_AUTODISPATCH` + configured Plane repos.
- **Orchestrator (auto-verify + auto-land)** — settle → verify → land; retry ~30s; parks a branch after 3 consecutive fails; escalation cap 20.
- **Observer** — periodic self-audit per Plane repo (`OMP_SQUAD_OBSERVE`): audits backlog, files/closes/reopens issues, runs the main gate, detects land-failure streaks.
- **Scout** — semantic harvest of live agents' reasoning → files latent items to Plane (`OMP_SQUAD_SCOUT`); rides run-end + periodic sweep.
- **Sentinel v0 (drift probe)** — rides Scout's cursor (opt-in `OMP_SQUAD_SENTINEL`, default off).
- **Opportunity** — zero-token clustering over Scout issues + receipt hot areas → themed issues (`OMP_SQUAD_OPPORTUNITY`).
- **Plan-sync** — reconciles `plans/<x>/NN-concern.md` STATUS against Plane pointers (default 300s).
- **PR-reconciler** — backstop for human-merged/closed PRs + crash-window ordering (default 120s; DB mode).
- **Weekly episode** — hourly tick against a durable weekly deliverable; per-repo brief + web-push (`GLANCE_EPISODE`, default on).
- **Resident planner** — decomposes `plans/<name>/OBJECTIVE.md` into a concern-DAG (opt-in `OMP_SQUAD_RESIDENT_PLANNER`).
- **Lease gossip** (federation-sync) — publishes owned-lease batches (`LEASE_GOSSIP_INTERVAL_MS`).
- **Reapers/sweeps** (~30s): orphan hosts, dead worktrees (120s grace), stale chat attachments, leases, dead sessions, presence, proofs, gate logs.
- **Watchdog** (`src/watchdog.ts`) — every poll samples host health (RSS leak, load/CPU, low memory, runaway orphan count) → daemon log + `/api/health`.
- **ACP orphan reaper** — boot-time (not periodic): reaps leaked `npx → *-acp` chains by persisted pid, fail-closed on argv-fingerprint mismatch (Linux `/proc` only).

Note: `land-sweep`, `dogfood-drain`, `reality-audit`, `make-it-work`, etc. are operator-invoked
skills/`/loop` cadences, not daemon-internal loops.

---

## 12. Other integration surfaces

- **Plane ticket pipeline** (`src/plane.ts`) — bidirectional issue-tracker seam, env-configured (`PLANE_API_KEY`, `PLANE_WORKSPACE`, `PLANE_BASE_URL`, `PLANE_PROJECT_ID`, `PLANE_PROJECT_MAP`). Feeds auto-dispatch/Observer/Scout/Opportunity/plan-sync; can spawn a unit from an issue; parses Tier-2 schema. Unconfigured → HTTP 501. Supporting: `plane-throttle.ts`, `plane-secrets.ts`, `plane-curator.ts`.
- **Federation** (`src/federation.ts`, `federation-sync.ts`) — cross-operator "team room" behind `FederationBus`. `NullFederationBus` is the v1 default (opt-out `OMP_SQUAD_FEDERATION=0`); `TailnetFederationBus` is the real transport (WS over Tailscale, identity via `tailscale whois`, ACL/delegation gating, audited remote commands, advisory acks); `LocalFederationBus` forwards to the tailnet peer; `RelayFederationBus` is documented as optional/planned. Lease gossip lets peers see each other's live file leases; remote commands are advisory-only, never authority.
- **Push notifications** (`src/push.ts`, `completion-push.ts`) — dependency-free Web Push (RFC 8291/8188/8292 VAPID via WebCrypto). Two pure-decider lanes so web-push and TUI OSC never drift: **escalation** (input/error transitions, deep-links `/#/agent/<id>?push=1`) and **completion** (working→idle, once per armed dispatch). Voice dispatches always arm; casual console arms by default; fleet units default quiet; category pushes duration-gated. `/api/push-tap` records an adoption counter.
- **Git / omp hooks** (`src/install-hooks.ts`) — installs squad coordination as an omp-discovered extension at `~/.omp/agent/extensions/omp-squad-coord/index.ts` (re-exports `presence-hook.ts` + `lease-hook.ts`), so every plain `omp` session joins squad presence + advisory file-lease coordination without a per-invocation flag. Advisory only (warns once per file per session, never a hard lock). `uninstall` has no CLI wiring yet (named gap). This is an omp-extension install, not a `.git/hooks` install.
- **Harness lifecycle webhook** — `POST /api/harness-events` (operator-tier localhost ingress); see §9.
