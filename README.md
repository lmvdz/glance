# omp-squad

**Manage a fleet of [Oh My Pi](https://omp.sh) agents running in parallel — one per git worktree — from a terminal TUI *and* a web dashboard.**

Like `claude agents`, but for the omp harness, and built to go further. The end goal is a
single **control plane you run wherever development happens** — a web UI where you coordinate
your own agents *and* any linked agents across your organization. Every agent is an isolated
worktree process; you see at a glance **what each is doing and which need input**, and you can
dive into any one and steer it. Cross-org coordination is the [Phase 2](#phase-2--cross-operator-federation)
federation layer — the same UI, with teammates' agents in the roster.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ omp-squad  3 agents · 1 need input                            + Add agent  │
├───────────────────────────────┬──────────────────────────────────────────┤
│ ⛔ input   bravo  squad/bravo  │ bravo [input]  anthropic/claude-opus      │
│ ◐ working  alpha  squad/alpha  │ ───────────────────────────────────────  │
│ ● idle     charlie squad/char  │ USER      refactor the auth module        │
│                                │ ASSISTANT I'll start by reading auth.ts…  │
│                                │ TOOL      ▸ edit: src/auth.ts             │
│                                │ ⛔ Allow tool: bash  [Approve] [Deny]     │
│                                │ prompt› _                                  │
└───────────────────────────────┴──────────────────────────────────────────┘
```

---

## Why

You're running several coding agents at once (a refactor here, a bug hunt there, a
spike in a third repo). Without a control plane you lose track of which is busy, which
finished, and **which is blocked waiting for you**. omp-squad is that control plane:

- **Isolation by default** — each agent works in its own `git worktree`, so parallel
  agents never clobber each other's files.
- **One glance** — a live status board: `working / idle / needs-input / error`, current
  activity, todo progress, context-window usage.
- **Never miss a blocked agent** — approval prompts, the `ask` tool, and host-tool calls
  surface as **needs-input** with inline answer controls.
- **Steer from anywhere** — send instructions, answer prompts, interrupt, restart, or
  kill any agent from the TUI or the browser. Both surfaces are thin clients of the same
  core, so they stay in sync.

## How it works

```
        omp-squad (one process)
        ┌─────────────────────────────────────────────┐
        │  SquadManager  ── roster, status, transcript │
        │     │                                        │
        │     ├── RpcAgent ──▶ omp --mode rpc  (wt #1) │   each agent =
        │     ├── RpcAgent ──▶ omp --mode rpc  (wt #2) │   its own worktree
        │     └── RpcAgent ──▶ omp --mode rpc  (wt #3) │   + RPC child process
        │     │                                        │
        │     ├── SquadServer (HTTP + WS) ──▶ browser  │
        │     └── SquadTui    (terminal)               │
        └─────────────────────────────────────────────┘
```

- Each agent is a real `omp --mode rpc` child. We speak omp's documented newline-JSON
  RPC protocol: send `prompt` / `steer` / `abort` / `get_state`, receive the
  `agent_start … message_update … agent_end` event stream.
- **Status** is derived from that stream: `agent_start`→working, `agent_end`→idle, a
  blocking `extension_ui_request` or `host_tool_call`→**needs-input**, crash→error.
- The **TUI** consumes the manager in-process; the **web dashboard** is a WebSocket
  client of the same `SquadEvent` stream. Anything you do in one shows up in the other.
- Roster config persists to `~/.omp/squad/state.json`; worktrees live under
  `~/.omp/squad/worktrees/`.

## Install

Requires [Bun](https://bun.sh) ≥ 1.3.14 and `omp` on your `PATH`.

```bash
cd omp-squad
bun install
bun link            # optional: makes `omp-squad` global
```

Run without linking via `bun src/index.ts <cmd>`.

## Usage

```bash
# Start the daemon — opens the TUI and serves the web dashboard (default :7878)
omp-squad up

# …or headless (web only), e.g. on a server
omp-squad up --no-tui
```

> One daemon per state dir. `up` takes a single-writer lock (`daemon.lock` in the state dir,
> default `~/.omp/squad`) before touching disk; a second `up` against the same dir refuses to
> start (exit 1) rather than race on `state.json`, receipts, and agent sockets. A self-upgrade
> hands the lock off cleanly, and a crashed daemon's stale lock is reclaimed automatically. To
> run a second, isolated daemon, point it at another dir with `OMP_SQUAD_STATE_DIR`.

> Running it on a server / leaving it up? See [`docs/operations.md`](docs/operations.md) — how to
> run the daemon so it survives (don't `&` it from an ephemeral shell), and why intermittent
> health-check timeouts under heavy fan-out are transient event-loop stalls, not crashes.

From another shell (talks to the running daemon):

```bash
# Spawn an agent in a fresh worktree of a repo, with an initial task
omp-squad add ~/code/myproject --name auth-refactor \
  --task "Refactor the auth module to use the new session API."

# See the roster
omp-squad list

# Send a follow-up instruction
omp-squad prompt auth-refactor-<id> "Also update the tests."

# Remove it (and delete its worktree)
omp-squad rm auth-refactor-<id> --delete-worktree
```

Open the dashboard in a browser: `omp-squad open` prints the URL (default
`http://127.0.0.1:7878`). The **+ Add agent** button and per-agent composer/answer
controls do everything the CLI does.

### `add` flags

| Flag | Meaning | Default |
|---|---|---|
| `--name` | Agent name | `agent-N` |
| `--branch` | Worktree branch | `squad/<name>` |
| `--model` | Model (fuzzy: `opus`, `gpt-5.2`) | omp default |
| `--approval` | `always-ask` \| `write` \| `yolo` | `write` |
| `--thinking` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` | `low` |
| `--task` | Instruction sent once ready | — |
| `--workflow` | Run a workflow graph (`.fabro`) as the process; `--task` is the goal | — |
| `--verify` | Wrap `--task` in an implement → verify → fixup loop (gate = `<cmd>` exit 0) | — |
| `--sandbox` | Run the agent inside a container from `<image>` (mounts the worktree) | — |
| `--acp` | Run an ACP runtime (`auggie --acp`) instead of `omp --mode rpc` | — |

> **Thinking defaults to `low`** so fleet agents stay responsive; bump it per-agent for
> hard work. (Inheriting a global `high` default makes every agent grind — opt in
> deliberately.)

### TUI navigation

Two levels, arrow-driven (like `claude agents`):

- **Dashboard (list):** `↑/↓` move between agents · `→` (or `Enter`) open the selected agent · **type a task + `Enter` to spawn a new agent** in the launch directory.
- **Agent (session):** type + `Enter` to steer it (or answer a pending request) · `←` on an empty prompt returns to the dashboard · `↑/↓` scroll the transcript · `/stop` `/restart` `/kill` as slash-commands.
- `Ctrl-C` quits anywhere; `Esc` backs out (agent → list → quit).

New agents spawn in a git worktree when the directory is a repo, otherwise they run in place.

## Verify

```bash
bun test            # deterministic suite — no model tokens spent
bun run check       # typecheck
```

The suite covers worktree ops, the pure board renderer, the RPC transport
(`get_state` + `bash`), and the manager lifecycle. A full model-driven check:

```bash
omp-squad up --no-tui &
omp-squad add /path/to/git/repo --name demo --approval yolo \
  --task 'Create a file proof.txt containing OK via a shell command, then stop.'
omp-squad list           # watch demo go working → idle
cat ~/.omp/squad/worktrees/<repo>-squad-demo/proof.txt   # → OK
```

## Command center

The web UI is an **organizational command center**, not a flat list:

- **Projects** (sidebar) — agents grouped by repo, each with a live status rollup and a needs-input badge.
- **Global views** (sidebar) — three fleet-wide surfaces, each deep-linkable and reachable via the ⌘K command palette:
  - **Features** — a kanban of in-flight features by lifecycle stage (planned → review → landed → done); spawn a research→plan→implement workflow that tracks itself across the columns.
  - **Queue** — an attention inbox of every agent blocked on input (and errored) across the whole fleet, answerable in place, oldest-first, so you supervise by exception.
  - **Race** — a race-board: one lane per agent with the workflow's phases as a segmented track, filled by stage progress and labelled with the current phase, so you see who's where in the pipeline and who's stalled at a glance. Fan-out branches nest under their parent.
- **Project view** — the agents advancing that project, a *spawn-in-this-project* composer (type a task → agent), and a **Plane issues** panel (open issues; click to spawn an agent on one).
- **Agent view** — transcript + composer + pending-answer controls, plus side panels:
  - **Subagents** — the live tree of `task`-spawned children (via omp's RPC subagent stream).
  - **Changes** — the agent's worktree git diff, so you can review before merging.

### Plane integration

Set on the daemon to pull real work items into the command center:

| Env | Meaning |
|---|---|
| `PLANE_API_KEY` | Plane API token (required to enable) |
| `PLANE_WORKSPACE` | Workspace slug (required) |
| `PLANE_BASE_URL` | API base (default `https://api.plane.so`) |
| `PLANE_PROJECT_ID` | Fallback Plane project id for every repo |
| `PLANE_PROJECT_MAP` | JSON `{ "<repo path or basename>": "<plane project id>" }` |

Unset → the issues panel shows "Plane not connected" and everything else works.

**Auto-dispatch (on by default when Plane is configured)** — the daemon polls the mapped repos
and spawns a routed agent per new open issue (issue → routed run → verify → land → close), so work
starts with nobody typing. Set `OMP_SQUAD_AUTODISPATCH=0` to disable. Bounded so a backlog can't storm:

| Env | Meaning |
|---|---|
| `OMP_SQUAD_AUTODISPATCH` | Issue → agent loop — **on** when Plane is configured (`=0` to disable) |
| `OMP_SQUAD_DISPATCH_INTERVAL_MS` | Poll interval (default `60000`) |
| `OMP_SQUAD_DISPATCH_MAX` | Max concurrent dispatched agents (default `3`) |
| `OMP_SQUAD_AUTOCLOSE` | Mark an issue done once its agent passes a verification gate (on by default; `=0` to disable) |

### Concurrency & autonomy

The daemon caps concurrent **live** agents (everything not `stopped`/`error`) at a global WIP
ceiling, and can optionally queue spawns past it and auto-answer routine prompts so a fleet keeps
moving without a human. All bounded and **on by default** — set the matching `OMP_SQUAD_*=0` to opt out of any one.

| Env | Meaning |
|---|---|
| `OMP_SQUAD_MAX_WIP` | Global live-agent WIP ceiling (default `6`); a spawn past it is refused |
| `OMP_SQUAD_MAX_AGENTS` | Absolute live-agent ceiling that even bypass-cap (fan-out) spawns respect, so runaway/looping fan-out can't over-spawn the host (default `2×` the WIP cap, floor `12`) |
| `OMP_SQUAD_QUEUE_ON_FULL` | At the cap, **park** the spawn (FIFO) and return a `queued` signal instead of erroring; the orchestrator spawns it when a slot frees. Off ⇒ the historical hard-cap error |
| `OMP_SQUAD_AUTOSUPERVISE` | Auto-answer **low-risk** pending requests (routine approve/continue gates) so blocked agents advance without you — **on by default** (`=0` to disable). Skips anything matching a destructive pattern (force-push, delete, deploy, prod, …) and every host-tool call; each auto-answer is logged for audit |
| `OMP_SQUAD_AUTOSUPERVISE_BUDGET` | Per-agent cap on auto-answers (default `5`); past it, that agent's requests fall back to the human queue |

With auto-land on, work merges without a human in the loop, so the safety net is the **verify gate**
(build + tests) plus the resolver's reviewer pass — and the risk gate that leaves every destructive
request (force-push, delete, deploy, prod, …) and host-tool call for a human. The worktree is still the blast radius.

**Self-healing control loop (on by default)** — the orchestrator's periodic tick is armed unless
`OMP_SQUAD_AUTODRIVE=0`. Each pass it auto-lands idle agents whose work verifies green (closing the
tracking Plane issue), self-heals red gates through the failure router (retry / hold /
escalate by repair budget), trips a single human-summoning `CATASTROPHE:` log on budget
exhaustion or a catastrophe tripwire (infra failure, safety violation, regression
oscillation), and drains cap-parked spawns back in under the WIP ceiling. On by default; set
`OMP_SQUAD_AUTODRIVE=0` to disable — then the daemon arms no timer and the tick is fully inert.

**Orphan-host reaping.** Each agent runs in a detached `agent-host` process that outlives the daemon
(so a restart/upgrade reconnects to live agents with full context). A host left behind by a crash,
re-exec, or a re-spawn under a fresh id — one the roster no longer owns — is shut down (over the host
protocol) on daemon startup and on a periodic poll tick, so phantom `omp` processes can't accumulate.
Together with `OMP_SQUAD_MAX_AGENTS`, the fleet's process count stays bounded across daemon lifetimes.

### Federation (opt-in)

`OMP_SQUAD_COORDINATOR=<ws url>` joins the daemon to a team coordinator as `OMP_SQUAD_OPERATOR`
(or your OS username) via `TailnetFederationBus`; unset → single-operator with `NullFederationBus`.

When a coordinator is set, the command center surfaces who else is on the tailnet: a
**Federation** panel (in each project view) lists peer operators, their live agents, and any
**shared-branch collisions** — repos where agents owned by different operators sit on the same
branch. It's backed by `GET /api/federation` (`{ coordinator, operators, collisions }`, bearer-gated).
With no coordinator the panel stays hidden and the endpoint returns just your own roster.

## Remote access & mobile

The dashboard is a PWA you can install on your phone and drive from anywhere — and it
**pushes you a notification the moment an agent needs a human**, so you supervise by
exception instead of watching a screen.

**Access is token-gated.** The daemon generates a bearer token on first run
(`~/.omp/squad/access-token`, mode 0600) and prints it on boot with one-tap sign-in links.
Every `/api` request and the WebSocket carry it; the static shell is the only public
surface. The token is required even on loopback (the control plane can spawn agents, land
code, and re-exec the daemon — it must not be open).

```
omp-squad daemon running
  dashboard: http://0.0.0.0:7878
  access token: Bdnw7…IHo
  open from any device on this network (tap to sign in):
    http://192.168.1.20:7878/?token=Bdnw7…IHo
```

### Multi-tenant mode (`DATABASE_URL`) — opt-in

By default the daemon runs in **file mode**: the token-gated, single-operator tool described
above (state under `~/.omp/squad`, no accounts). Set **`DATABASE_URL`** and it boots in **DB
mode** — a multi-tenant identity layer backed by [BetterAuth](https://better-auth.com):

- **Accounts + sessions** replace the bearer token. The dashboard shows a sign-in / sign-up
  screen; auth is email + password with httpOnly cookie sessions (`/api/auth/*`).
- **Organizations, members, roles.** A user creates orgs, invites members by email, and assigns
  roles (`owner` > `admin` > `member`); the active-org role bridges to the fleet's RBAC tiers
  (owner/admin → `admin`, member → `operator`).
- **Settings surface** (gear in the nav): Account, Organization, Members, Roles & Permissions —
  plus Appearance / Notifications / Daemon, which also show in file mode.
- **Storage.** `postgres(ql)://…` ⇒ Postgres (with row-level-security backstops); anything else
  (`sqlite:<path>` or a bare path) ⇒ SQLite. Auth + app tables migrate on boot.

| Env | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | Unset ⇒ file mode. `postgres://…` ⇒ Postgres; `sqlite:<path>`/path ⇒ SQLite. Enables DB mode. | _(unset)_ |
| `BETTER_AUTH_SECRET` | Session-signing secret — **set a strong value in production** | dev-insecure default |
| `BETTER_AUTH_URL` | Public base URL for auth origin checks | the daemon's bind URL |

> **Maturity** (tracked in Plane → module *Multi-tenant SaaS*). Landed + verified: the DB
> foundation (P0), the BetterAuth identity layer (P1, *pending human security review*), and the
> web settings/org/member UI. **Not yet landed:** per-org runtime isolation (P2) and full RBAC
> enforcement on every mutation (P3) — so today all authenticated users of a DB-mode daemon share
> one fleet/state. DB mode previews the SaaS surface; it is **not** a tenant-isolated production
> deployment yet. File mode is the default and unaffected.

**Bind beyond loopback** to reach it from your phone:

| Env / flag | Meaning | Default |
|---|---|---|
| `--host` / `$OMP_SQUAD_HOST` | Bind address; `0.0.0.0` exposes on the LAN/tailnet | `127.0.0.1` |
| `$OMP_SQUAD_TLS_CERT` + `$OMP_SQUAD_TLS_KEY` | Terminate TLS in-process (PEM paths) | plain HTTP |
| `$OMP_SQUAD_PUSH_SUBJECT` | VAPID `sub` contact (`mailto:`/`https:`) | `mailto:squad@localhost` |

**HTTPS is required** to install the PWA and receive background push — browsers only allow
service workers + Web Push in a secure context (`http://localhost` is exempt, a LAN IP is
not). Two ways to get it:

- **Tailscale (recommended)** — front the daemon with a real cert, no in-process TLS:
  ```bash
  omp-squad up --no-tui            # bound to localhost is fine
  tailscale serve --bg 7878        # → https://<machine>.<tailnet>.ts.net
  ```
  Open that URL on your phone (same tailnet), append `?token=…` once, **Add to Home
  Screen**, allow notifications. Tailnet ACLs gate who can reach it; the token gates the rest.
- **In-process TLS** — point `OMP_SQUAD_TLS_CERT`/`KEY` at a cert and bind `--host 0.0.0.0`.
  Self-signed works but browsers warn (and some refuse a service worker on an untrusted
  cert), so a real cert / tailnet is smoother.

**On the phone:** the unified nav collapses to a drawer; the **attention queue is the
landing view** when something's waiting; one tap answers an approval or question. When an
agent transitions to *needs-input* or *error*, a Web Push notification fires (even with the
app closed) and tapping it deep-links to that agent. Push is RFC 8291 (`aes128gcm`) + RFC
8292 VAPID, implemented dependency-free in `src/push.ts`.

**Live-reload on upgrade.** The daemon stamps a `uiVersion` (a hash of the served
`index.html`, via `computeUiVersion`) onto every WS `roster` snapshot and `GET /api/version`.
The dashboard pins the first version it sees; after an `⤴ Upgrade` (or any daemon restart
with changed assets) the socket drops, the client auto-reconnects, sees a new version, and
**refreshes itself** ("Updated — reloading…") — so an open tab or installed PWA never runs
stale UI without anyone touching it.

## Commissioning — agents that author agents

A second fleet class lives beside the interactive omp operators: **`flue-service`
workers**. Instead of hiring a human when a job opens, the OS **authors its own
specialized worker** — a small, scoped [Flue](https://flueframework.com) agent — and
onboards it only if it passes an acceptance gate. The hire-replacement loop:

```bash
# Deterministic worker (no model): author → validate → onboard if the gate passes
omp-squad commission extract-emails \
  --purpose "Extract email addresses from payload.text; return { emails, count }." \
  --accept-payload '{"text":"a@x.io b@y.org"}' --accept-expect '{"count":2}'
```

- **Author** — an `Architect` writes the worker. The running daemon always uses
  `OmpArchitect`, which drives a real `omp --mode rpc` agent to write the workflow.
  `TemplateArchitect` (deterministic, no model) renders it straight from the spec, but it is
  wired only in the test suite — there is **no offline-architect fallback in the live daemon**.
  (`--model <spec>` makes the worker itself model-backed.)
- **Acceptance gate** (`src/validate.ts`) — tiered + degrading: **lint** (always) →
  **typecheck** → **`flue run` acceptance** (when the worker's toolchain is installed),
  deep-matching the result against `--accept-expect`. A failed gate **re-authors** (bounded),
  feeding the failure forward; still failing → onboards nothing.
- **Onboard** — a passing worker becomes a `flue-service` member via `FlueServiceDriver`,
  which adapts `flue run` into the same omp event frames the manager already derives
  status from. It shows in the roster (and federates) like any other agent.

The loop is itself a [workflow](#workflows--process-as-a-reviewable-graph) now
(`workflows/commission/workflow.fabro`, driven by `CommissionExecutor`) — not a hand-coded
sequence — so `author → gate → onboard` runs on the same engine as plan-implement.

Both classes implement one `AgentDriver` seam, so `kind` is the only thing surfaces
need to tell an interactive operator from a commissioned worker. Design + rationale:
[the Commissioning docs](docs-site/content/docs/commissioning/index.mdx) (rendered in the docs site).

## Autonomous intake — describe intent, the OS picks the process

The goal: a human **never has to do anything** but say what they want; the OS chooses
*how*. Spawning takes one natural-language line (the per-project composer, a Plane issue,
or `omp-squad add … --task`) — no forms, no flags. An **intake router** (`src/intake.ts`)
reads the task + repo and routes it:

- ordinary code change → an **autonomous verify loop** (implement → verify → fixup), using
  the repo's own detected test/typecheck command;
- genuinely high-risk change (migrations, deletions, deploys) → **plan + approval** — the
  *only* routine human-in-the-loop gate, reserved for the extreme cases;
- several approaches wanted → **parallel fan-out**;
- nothing to verify → a plain agent.

The choice is logged (`routed "<name>": <reason>`) so the operator sees the OS's reasoning;
`--plain` (or an explicit `--workflow` / `--verify` / `--sandbox`) overrides it. Routing is
heuristic by default; set `OMP_SQUAD_LLM_ROUTER=1` to classify intent with a one-shot call on
the fast/`smol` model instead (it falls back to heuristics on any failure) — same `routeIntake`
seam, no caller changes.

The same router powers **[auto-dispatch](#plane-integration)**: with `OMP_SQUAD_AUTODISPATCH`,
open Plane issues are pulled in and routed to agents on a timer — the human stops typing the
line at all, and supervises by exception.

## Workflows — process as a reviewable graph

A third fleet class runs a **workflow**: a process authored as a graph (the same
Graphviz/DOT dialect [fabro](https://github.com/fabro-sh/fabro) uses) — plan, a
human-approval gate, implement, a verification gate, and a bounded fix-up loop —
driven over one persistent omp thread. The agent's *process* becomes a diffable,
version-controlled artifact instead of being implicit in a free-text task.

```bash
omp-squad add ~/code/myproject --name feature \
  --workflow workflows/plan-implement/workflow.fabro \
  --task "Add rate limiting to the public API."
```

- **One seam, again.** `WorkflowDriver implements AgentDriver`, so a graph-driven run
  joins the same roster / TUI / web / federation as an omp operator — `kind` is the
  only difference. (The move that added `flue-service`.)
- **Pure engine, injected execution.** `src/workflow/engine.ts` walks the graph
  (routing, edge conditions, `goal_gate`, `retry_target`, visit caps, human gates); a
  `NodeExecutor` decides what a node *does*. `SingleAgentExecutor` binds sequential agent
  nodes to one omp thread (a run is one steerable roster entry).
- **Parallel fan-out = real fleet agents.** A `component` fork spawns one **real, steerable
  roster agent per branch** (each in its own worktree), runs them concurrently (`max_parallel`),
  and a `tripleoctagon` merge joins them (`join_policy: wait_all | first_success`). This is
  omp-squad's headline — parallel agents you can watch and steer — expressed as graph nodes.
  Branch agents **nest under their workflow** in the roster (TUI + web), and a kind glyph
  (`⚙` workflow · `⚒` service) tags each row.
- **Gates reuse needs-input.** A `hexagon` human node surfaces as the manager's ordinary
  `input` request (a `select` of the edge labels), answerable in the TUI and web; the
  inner agent's own approval prompts ride the same channel. Stages drive the dashboard's
  todo rollup, so you see "stage 3/6" with no new UI.
- **The commission loop is itself a workflow** (`JOB → AUTH → GATE{fail→AUTH}`); this
  generalizes that one hard-coded pipeline into authorable graphs.
- **Multi-model routing.** A graph-level `model_stylesheet` (CSS-like) routes each node to
  a model + reasoning effort by `*` / `.class` / `#id` — `*  { model: haiku; reasoning_effort: low; }`
  with `.coding { model: opus; reasoning_effort: high; }` — so the thread switches model before
  the hard nodes. Cheap by default, frontier where it counts.

**Just want a verify gate on a normal task?** `--verify "<cmd>"` synthesizes the
implement → verify → fixup loop for you — no `.fabro` file needed — turning "the agent
says it's done" into "done **and** the gate is green":

```bash
omp-squad add ~/code/myproject --task "Add rate limiting to the public API." \
  --verify "bun run check && bun test"
```

Shapes: `Mdiamond` start · `Msquare` exit · `box` agent · `tab` prompt · `parallelogram`
command · `hexagon` human gate · `diamond` conditional · `component` fork · `tripleoctagon`
merge. Design + rationale:
[the Workflows docs](docs-site/content/docs/workflows/index.mdx) (rendered in the docs site).

## Documentation

Full docs live in a self-contained [Fumadocs](https://fumadocs.dev) site under [`docs-site/`](docs-site/)
— MDX pages, ⌘K search, an **Ask-AI** chat, and machine-readable `llms.txt` / `llms-full.txt` endpoints
for LLMs. It's a separate Next.js app with its own `node_modules`, so the core package stays
dependency-free.

```bash
cd docs-site
bun install        # first run only
bun run dev        # http://localhost:3000/docs
```

Content is authored in `docs-site/content/docs/*`. Set `OPENROUTER_API_KEY` in `docs-site/.env.local`
to enable the Ask-AI chat.

## Landing — getting work back to main

A fleet only pays off when its branches **land**. `landAgent` (`src/land.ts`) commits an
idle agent's worktree on its `squad/<name>` branch and merges it into the main checkout —
fast-forward when it can, a merge commit when it diverged — serialized per-repo so two
lands never corrupt the index. The web **Land** button and `landFeature` (multi-branch)
drive the same path.

A successful land **closes the agent's tracking Plane issue** (idempotent, best-effort) — on both
the single-agent `land(id)` path and the multi-branch `landFeature` path — so a shipped branch
leaves no stale open issue behind.

When `main` has moved under a long-running branch, the merge **conflicts** — the point most
fleet tools give up at. The bundled **`resolve-conflict`** workflow is omp-squad's answer,
expressed as a reviewable graph rather than a black box:

```bash
omp-squad add <repo> --branch <conflicted-branch> --workflow resolve-conflict \
  --task "Make this branch land-able on main."
```

- **Merge main into the branch**, with `git rerere` replaying any resolution it has seen
  before — so the same hot file conflicting twice resolves itself the second time.
- **Resolve what's left with an intent-aware agent**, told to *combine both sides* (keep the
  branch's feature **and** main's change, dedupe identical fixes) rather than pick one.
- **A `goal_gate` verify step authorizes the commit** — `check && test`, not the absence of
  conflict markers, because a textually-clean merge can still be semantically wrong. A
  bounded fix-up loop retries; if it can't go green the run fails (escalate to a human)
  instead of landing red.
- Resolution lives **on the branch**, so the actual land stays a plain fast-forward and the
  resolved diff is reviewable in the Changes panel before `main` ever moves.

It runs on the same `WorkflowEngine` as plan-implement, so it joins the roster / TUI / web like
any other run.

**The workflow above is run manually** — the land flow never auto-invokes it; you launch it
with `--workflow resolve-conflict` as shown. Automatic resolution *at land time* is a
**separate path**: `landAgent` carries its OWN rebase-based resolver (`src/land.ts`, #12),
gated behind **`OMP_SQUAD_AUTORESOLVE`**. It rebases the branch onto main, hands each conflicted
file to a resolver (default: a one-shot `omp -p` agent), then **proves** the result — the full
verify gate must pass **and** an independent reviewer pass must approve — before completing the
land. Any failing step rolls `main` back to where it was; an unproven resolution is never kept.
It only runs when the worktree is clean, so a live agent's uncommitted edits are never clobbered.
The resolver/reviewer are injectable seams (tests use them; the defaults shell out to `omp`).
Ceiling: a verify gate + reviewer can still miss a *semantic* conflict that is textually clean
and compiles — see the `ponytail:` note on `attemptAutoResolve`.

**Landing it automatically, too.** `OMP_SQUAD_AUTORESOLVE` decides what happens *when* a land
conflicts; **`OMP_SQUAD_AUTOLAND=1`** decides *that a land happens at all* with no operator: a
workflow run that finishes successfully (`--verify`, plan-implement, an auto-dispatched issue)
lands its own branch the moment it goes green. With both on, the loop closes end to end — intake →
build → verify → **land** → resolve-on-conflict — and a human is needed only when a resolution
can't be proven.

| Env var | Effect |
|---|---|
| `OMP_SQUAD_AUTORESOLVE` | `landAgent`'s in-process rebase conflict resolver, distinct from the manual `resolve-conflict` workflow (on by default; `=0` to disable) |
| `OMP_SQUAD_AUTOLAND` | A successful workflow run auto-lands its own branch (on by default; `=0` to disable) |
| `OMP_SQUAD_LAND_CONFIRM` | Safety valve: the auto-land loop still verifies idle agents, but a GREEN verify only marks them **✓ ready to land** (no merge) — the operator merges via the existing one-tap Land (off by default) |
| `OMP_SQUAD_REPAIR_BUDGET` | `routeFailure` red-gate retry budget before escalating (default `3`) |

## Sandboxed execution — agents off your laptop

`--sandbox <image>` runs an agent's omp **inside a container** instead of locally — fabro's
"keep untrusted code off your laptop" isolation. Same `AgentDriver` seam, so a sandboxed
agent joins the roster / TUI / web / workflows like any other; only the transport (omp's
JSONL RPC over `docker exec -i`) and execution location change.

```bash
omp-squad add ~/code/myproject --sandbox my-omp-image --approval yolo \
  --task "Try the risky migration."
```

- **`SandboxAgentDriver`** launches a fresh `--name` container (`docker run`), bind-mounts the
  worktree at `/work` (process + network isolation, files still reviewable on the host —
  the Changes panel works), `docker exec -i`s `omp --mode rpc` inside it, and removes the
  container on `stop()`. Add `runArgs: ["--network=none"]` for full network isolation.
- The image must provide `omp`; point `--sandbox` at an omp-provisioned image. (The driver's
  container transport + lifecycle are verified against a real `oven/bun` container in the test
  suite using a fake-omp RPC server — no tokens; the real-omp path was proven live on the host.)

## ACP runtimes — a non-omp agent in the roster

`--acp` runs an **ACP-speaking runtime** (`auggie --acp`, and Claude Code / Codex via ACP)
behind the same `AgentDriver` seam that `RpcAgent` uses for `omp --mode rpc`. Same seam, so
an ACP runtime joins the roster / TUI / web / status / receipts **identically** — only the
transport (hand-rolled ACP JSON-RPC 2.0 over the child's stdio) and the agent runtime change.

```bash
omp-squad add ~/code/myproject --acp --task "Add rate limiting to the public API."
```

- **`AcpAgentDriver`** spawns the runtime as a child, handshakes (`initialize` → `session/new`),
  maps `session/update` (message chunks, tool calls, plan, usage) and the turn lifecycle to the
  same normalized frames the manager already derives, and bridges `session/request_permission`
  to the squad's confirm-UI (the human answer routes back as the ACP `{outcome}` reply).
- The child command is injectable; the default is `auggie --acp`. The driver's ACP transport +
  mappings are verified in the test suite against a fake in-process ACP agent — no auggie, no
  account, no tokens.

## Phase 2 — cross-operator federation

The single-operator squad above is built **federation-ready**: the manager already
programs against a transport-agnostic `FederationBus` (today a no-op `NullFederationBus`),
carries per-agent collision metadata (repo / branch / worktree), and routes every
command through one `applyCommand(cmd, actor)` entry point that accepts a remote actor.

The Phase-2 goal: a whole team's squads federate so a coordinator can **see what everyone's
agents are doing** and **steer a teammate's live agent** when they're away — their session
already has the fresh context.

- **Transport: Tailscale.** Run the coordinator on the tailnet; identity comes for free
  from `tailscale whois <peer-ip>` (sourced from your SSO), ACLs gate reachability, and
  WireGuard encrypts everything — collapsing transport + identity + authz into the network
  layer. (A `RelayFederationBus` over omp's content-blind `/collab` relay is the zero-infra
  alternative for small / cross-org rooms.)
- **What flows:** lightweight **presence** (operator, availability, agents, repos/branches/
  files-in-flight) by default — not transcripts. Deep view stays opt-in, reusing `/collab`'s
  view-link vs full-link split.
- **Remote steering** *(not yet implemented)* — the design: a peer's `{command, actor}` rides
  the bus to the owning squad, which authorizes it against the operator's **delegation/availability
  policy** (away/ill can auto-grant to delegates) before applying — and **audits** every
  cross-operator action. Today only the *receive* side exists (`onRemoteCommand` +
  `applyCommand(cmd, actor)`); no code yet *sends* a command frame, so driving a teammate's live
  agent is the remaining Phase-2 work.
- **Collision avoidance** *(live)* — overlapping repo+path across operators surfaces as a
  warning, so two people don't have agents editing the same file.

`src/federation.ts` defines the seam. `TailnetFederationBus` is implemented for **presence** and
**cross-host leases / collision detection** (live today); **remote steering** — the
delegation/availability policy plus the outbound command frame — is the rest of Phase 2.

## Layout

### Core

| File | Role |
|---|---|
| `src/types.ts` | Shared domain + wire types — `AgentRecord`/`AgentDTO`, `SquadEvent`, `ClientCommand` |
| `src/squad-manager.ts` | Roster, status derivation, transcript, persistence, `applyCommand` |
| `src/server.ts` | HTTP + WebSocket bridge (web dashboard + REST) |
| `src/auth.ts` | Bearer-token gate for the HTTP + WS surface (constant-time, persisted mode 0600) |

### Web & CLI

| File | Role |
|---|---|
| `src/web/index.html` | Single-page web dashboard |
| `src/tui.ts` | Terminal dashboard — `buildBoard` chrome + pi-tui `Editor` input, two-level nav |
| `src/index.ts` | CLI |

### Drivers & transport

| File | Role |
|---|---|
| `src/agent-driver.ts` | `AgentDriver` seam shared by `RpcAgent`, `FlueServiceDriver`, `WorkflowDriver` |
| `src/rpc-agent.ts` | Spawns + drives one `omp --mode rpc` child (JSONL transport) |
| `src/agent-host.ts` | Detached per-agent supervisor over a UDS — owns the omp child, survives a daemon restart |
| `src/agent-host-main.ts` | Thin entry for a detached `agent-host` process |
| `src/acp-agent-driver.ts` | Runs an ACP runtime (`auggie --acp`, Claude Code / Codex) behind `AgentDriver` |
| `src/sandbox-agent-driver.ts` | Runs an agent inside a container (`docker exec` + omp RPC) behind `AgentDriver` |
| `src/flue-service-driver.ts` | Adapts a commissioned Flue worker (`flue run`) to `AgentDriver` |
| `src/workflow-driver.ts` | Runs a workflow graph behind `AgentDriver` (one omp thread per run) |
| `src/subagents.ts` | `SubagentTracker` — RPC subagent stream → live hierarchy tree |
| `src/worktree.ts` | `git worktree` add / remove / status |

### Workflow engine

| File | Role |
|---|---|
| `src/workflow/types.ts` | Workflow graph domain model — nodes, stages, run state |
| `src/workflow/dot.ts` | DOT-subset parser → typed `Workflow` graph |
| `src/workflow/engine.ts` | Pure graph walker — routing, conditions, gates, fix-up loops |
| `src/workflow/executor.ts` | `SingleAgentExecutor` — binds nodes to an omp thread + shell |
| `src/workflow/commission-executor.ts` | `CommissionExecutor` — runs the commission graph's action nodes |
| `src/workflow/verify-workflow.ts` | `buildVerifyWorkflow` — synthesizes the `--verify` implement → verify → fixup loop |
| `src/workflow/stylesheet.ts` | CSS-like `model_stylesheet` parser + per-node model/effort resolver |

### Autonomy & orchestration

| File | Role |
|---|---|
| `src/intake.ts` | Intake router — turns a plain task into a process (verify / plan / fan-out) |
| `src/smart-spawn.ts` | Turns one free-text line into a ready-to-run spawn plan (fast model + heuristic fallback) |
| `src/dispatch.ts` | Auto-dispatch — polls Plane, routes new issues to agents (bounded; on by default when Plane is set) |
| `src/orchestrator.ts` | Self-healing control loop — auto-land → self-heal → catastrophe → admission drain (on by default) |
| `src/scheduler.ts` | Admission + global WIP ceiling, with a FIFO park queue for spawns past the cap |
| `src/resolver.ts` | Failure-routing policy — retry / hold / escalate by a bounded repair budget |
| `src/supervisor.ts` | Auto-supervisor — answers low-risk pending requests via a one-shot omp agent |
| `src/autoland.ts` | Auto-land policy — a successful workflow run lands its own branch (pure decision) |

### Landing & git

| File | Role |
|---|---|
| `src/land.ts` | Landing — commit a branch + merge into main (ff / merge commit), serialized per-repo; opt-in rebase auto-resolve |
| `src/proof.ts` | Land proof — deterministic acceptance command keyed to HEAD; the gate refuses a stale proof |
| `src/vision.ts` | Optional browser-vision evidence pass (screenshots + notes) — evidence only, never gates |
| `src/explore.ts` | Worktree file tree + git diff (the Changes panel) |
| `src/git-harden.ts` | Hardening args/env for read-only git on untrusted repos (no hooks / pager / prompt) |

### Commissioning

| File | Role |
|---|---|
| `src/architect.ts` | `OmpArchitect` (omp-authored — the daemon default) + `TemplateArchitect` (deterministic, test-only) |
| `src/worker-template.ts` | `CommissionSpec` → runnable Flue worker project files |
| `src/validate.ts` | Acceptance gate — lint · typecheck · `flue run` |

### Federation & presence

| File | Role |
|---|---|
| `src/federation.ts` | Federation seam + `NullFederationBus` / `TailnetFederationBus`, `mergeRosters`, `detectCollisions` |
| `src/coordinator.ts` | Protocol-agnostic WebSocket relay/hub every `TailnetFederationBus` connects to |
| `src/coordinator-main.ts` | CLI entry for the federation coordinator |
| `src/federation-sync.ts` | Cross-host file leasing over the tailnet — publishes/mirrors local leases by repo identity |
| `src/federation-sync-main.ts` | CLI entry for the cross-host lease-sync process |
| `src/repo-identity.ts` | Cross-host repo identity — normalize a git origin URL to `host/owner/repo` |
| `src/ttl-registry.ts` | Generic file-per-record heartbeat-TTL registry — the shared spine behind `presence.ts` + `leases.ts` |
| `src/presence.ts` | Presence/claim registry — who or what is working a repo now (heartbeat-TTL, file-per-claim) |
| `src/presence-hook.ts` | omp hook — a raw `omp` session announces its repo to the squad |
| `src/sessions.ts` | Discovers raw (non-squad) omp sessions from the OS process table into presence |
| `src/leases.ts` | Soft advisory file leases — "I'm editing this file" claims (heartbeat-TTL, file-per-lease) |
| `src/lease-hook.ts` | omp edit hook — soft-block-with-override when another session holds the file |
| `src/ownership.ts` | Path-ownership partition — refuse a spawn whose paths overlap a live agent's |
| `src/install-hooks.ts` | Installs the presence + lease hooks as an omp-discovered extension |

### Supporting services

| File | Role |
|---|---|
| `src/plane.ts` | Plane issue client (env-configured) |
| `src/features.ts` | Feature derivation (plans + roster agents) with live land status |
| `src/receipts.ts` | Per-run receipt ledger (tokens / cost / files) — accumulator + JSONL persistence |
| `src/digest.ts` | Zero-token transcript digests for cold-start resume |
| `src/summarizer.ts` | Local extractive TF-IDF + TextRank summarizer (vendored, zero-token) |
| `src/redact.ts` | Best-effort secret-shape redaction before anything is persisted or displayed |
| `src/push.ts` | Dependency-free Web Push (RFC 8291 / 8188 / 8292) for escalation alerts |
| `src/upgrade.ts` | Self-upgrade — git state · fast-forward pull · re-exec the daemon |
| `src/omp-oneshot.ts` | Shared one-shot `omp` call — spawn + JSON-extraction for smart-spawn / intake / supervisor |

### Bundled workflows

| Path | Role |
|---|---|
| `workflows/plan-implement/` | Bundled plan → approve → implement → verify → fixup graph |
| `workflows/commission/` | Bundled author → validate → onboard graph (the commission loop) |
| `workflows/fan-out/` | Bundled parallel fan-out → merge graph (one fleet agent per branch) |
| `workflows/resolve-conflict/` | Bundled merge → resolve → verify → fixup graph (run manually via `--workflow resolve-conflict`) |
