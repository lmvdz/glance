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
| `src/tui.ts` | Terminal dashboard (pure `buildBoard` + interactive shell) |
| `src/federation.ts` | Phase-2 transport seam (`FederationBus`) |
| `src/index.ts` | CLI |
