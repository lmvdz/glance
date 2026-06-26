# omp-squad webapp

This is the active Vite + React starter UI for the future dashboard.

The previous React dashboard lives in `../webapp-legacy/` for reference while
we rip useful pieces forward.

The UI keeps the starter look. Omp-squad data enters through thin adapters:
`/api/projects`, `/api/features`, `/api/features/:id/pipeline`,
`/api/agents`, `/api/capabilities`, `/api/capability-catalog`, and `/ws`
are mapped into the starter task/capability surfaces in `src/lib/task-model.ts`,
`src/lib/capability-view.ts`, and `src/context/TaskContext.tsx`.
Assistant chat uses `/api/console` plus the daemon websocket. Console agents get
a chat-first appended system prompt: they answer and diagnose by default, and
only mutate/create work when the operator explicitly asks.
Live agent turns render as a compact work timeline: the prompt stays separate,
the current action shimmers while the agent is thinking or calling tools, tool
payloads expand on demand, and completed work folds behind a "Worked for..."
summary with an inline `/api/agents/:id/diff` review panel for changed files.
The task detail view persists description, foldable acceptance criteria, decisions,
relationships, and comments back to daemon APIs; the context bundle rows drill
into plan documents, linked issues, prerequisites, decisions, and downstream
agents. Selecting a plan document renders GitHub-flavored markdown, including
tables, in a draggable split reading pane so operators can review the source plan
without losing the editable task context. The left workbench pane combines
project context, task status buckets, workspace progress, filters, search, and
task selection into one collapsible surface when the plan needs more room. The
task/detail split and assistant chat keep keyboard-accessible drag handles with
persisted widths and double-click reset defaults, tuned for denser laptop-sized
workspaces.
The task list trash action archives the backing feature; for plan-derived rows,
the daemon adopts the plan first so stale `plans/<name>` directories stay hidden
after refresh.
The proof/provenance panel in task detail renders the structured `FeatureDTO`
contract: canon source, candidate worktrees, proof aggregate, readiness blocker,
next action, and plan revision candidates. It keeps raw command output hidden by
default; proof freshness is distinct from run evidence such as receipts, traces,
token/cost rollups, screenshots, and artifact counts.
Theme switching is class-based: `ThemeContext` toggles the `dark` class on the
document element, and Tailwind's `dark:` variants are bound to that class.
Assistant chat restores the newest valid local session after reload and queues
early websocket commands until the daemon socket opens, so the first prompt is
not dropped during startup.
Task selection is explicit: after reload the detail pane remains empty until an
operator selects a task, and stale selections are cleared instead of replaced.
Operators annotate selected plan text inline from a popover, see highlighted
ranges with stable per-author colors, watch annotations arrive live from other
dashboard sessions, resolve them, or send them to an existing agent / new planner
agent for markdown plan revisions. Planner output is registered as a low-trust
plan revision candidate; the operator can accept, reject, or supersede it while
preserving producer agent, plan path, summary, timestamps, and reviewer state.
The Capabilities view renders both the public catalog and imported
agentcn-style packs, install state, runtime bindings, and run/enable/disable
actions from daemon APIs; it does not hardcode private recipe data in React.

## Commands

```sh
bun install
bun run typecheck
bun run dev
```

`bun run dev` proxies `/api` and `/ws` to the daemon at `127.0.0.1:7878`.
Override that with `OMP_SQUAD_PROXY`.

The production daemon still serves this app only when `OMP_SQUAD_WEBAPP=1` and
`webapp/dist/index.html` exists.
