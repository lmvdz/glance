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

### Federation (opt-in)

`OMP_SQUAD_COORDINATOR=<ws url>` joins the daemon to a team coordinator as `OMP_SQUAD_OPERATOR`
(or your OS username) via `TailnetFederationBus`; unset → single-operator with `NullFederationBus`.

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

- **Author** — an `Architect` writes the worker. `OmpArchitect` (default) drives a real
  `omp --mode rpc` agent to write the workflow; `TemplateArchitect` renders it
  deterministically. (`--model <spec>` makes the worker itself model-backed.)
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
[`docs/commission-loop.md`](docs/commission-loop.md).

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
`--plain` (or an explicit `--workflow` / `--verify` / `--sandbox`) overrides it. Heuristics
today; an LLM router drops in behind `routeIntake` without changing a single caller.

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
[`docs/workflow-runtime.md`](docs/workflow-runtime.md).

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
- **Remote steering:** a peer's `{command, actor}` rides the bus to the owning squad, which
  authorizes it against the operator's **delegation/availability policy** (away/ill can
  auto-grant to delegates) before applying — and **audits** every cross-operator action.
- **Collision avoidance:** overlapping repo+path across operators → a warning, so two people
  don't have agents editing the same file.

`src/federation.ts` defines the seam; implementing `TailnetFederationBus` is the bulk of
Phase 2 — transport + policy, not surgery.

## Layout

| File | Role |
|---|---|
| `src/rpc-agent.ts` | Spawns + drives one `omp --mode rpc` child (JSONL transport) |
| `src/worktree.ts` | `git worktree` add / remove / status |
| `src/squad-manager.ts` | Roster, status derivation, transcript, persistence, `applyCommand` |
| `src/server.ts` | HTTP + WebSocket bridge (web dashboard + REST) |
| `src/web/index.html` | Single-page web dashboard |
| `src/tui.ts` | Terminal dashboard — `buildBoard` chrome + pi-tui `Editor` input, two-level nav |
| `src/subagents.ts` | `SubagentTracker` — RPC subagent stream → live hierarchy tree |
| `src/agent-driver.ts` | `AgentDriver` seam shared by `RpcAgent`, `FlueServiceDriver`, `WorkflowDriver` |
| `src/flue-service-driver.ts` | Adapts a commissioned Flue worker (`flue run`) to `AgentDriver` |
| `src/workflow-driver.ts` | Runs a workflow graph behind `AgentDriver` (one omp thread per run) |
| `src/sandbox-agent-driver.ts` | Runs an agent inside a container (`docker exec` + omp RPC) behind `AgentDriver` |
| `src/workflow/dot.ts` | DOT-subset parser → typed `Workflow` graph |
| `src/workflow/engine.ts` | Pure graph walker — routing, conditions, gates, fix-up loops |
| `src/workflow/executor.ts` | `SingleAgentExecutor` — binds nodes to an omp thread + shell |
| `src/workflow/commission-executor.ts` | `CommissionExecutor` — runs the commission graph's action nodes |
| `src/workflow/verify-workflow.ts` | `buildVerifyWorkflow` — synthesizes the `--verify` implement → verify → fixup loop |
| `src/workflow/stylesheet.ts` | CSS-like `model_stylesheet` parser + per-node model/effort resolver |
| `src/intake.ts` | Intake router — turns a plain task into a process (verify / plan / fan-out) |
| `workflows/plan-implement/` | Bundled plan → approve → implement → verify → fixup graph |
| `workflows/commission/` | Bundled author → validate → onboard graph (the commission loop) |
| `workflows/fan-out/` | Bundled parallel fan-out → merge graph (one fleet agent per branch) |
| `src/architect.ts` | `TemplateArchitect` (deterministic) + `OmpArchitect` (omp-authored) |
| `src/worker-template.ts` | `CommissionSpec` → runnable Flue worker project files |
| `src/validate.ts` | Acceptance gate — lint · typecheck · `flue run` |
| `src/explore.ts` | Worktree file tree + git diff (the Changes panel) |
| `src/plane.ts` | Plane issue client (env-configured) |
| `src/federation.ts` | Federation seam + `TailnetFederationBus`, `mergeRosters`, `detectCollisions` |
| `src/index.ts` | CLI |
