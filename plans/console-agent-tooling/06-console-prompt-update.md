# Teach the console agent to investigate
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/server.ts, tests/console-tools.test.ts (or a server prompt test)

BLOCKED_BY: 02, 03, 04, 05

## Goal
The console agent reaches for its tools before answering fleet/status questions, and states what it checked — turning "here's your snapshot back" into an investigated answer.

## Approach
Update `CONSOLE_SYSTEM_PROMPT` (`src/server.ts:73-75`):
- Keep the existing identity + don't-mutate guardrails verbatim.
- Add an investigation directive, roughly: for questions about fleet state, agents, tickets, or "what needs me", call `squad_needs_attention` / `squad_fleet_status` first and drill down with `squad_worktree_inspect` / `squad_ticket_lookup`; prefer live tool results over any snapshot injected into the prompt; say which tools you checked; if a tool errors or Plane is unconfigured, say so rather than guessing.
- Keep it tight (a paragraph, not a page) — the tool descriptions themselves carry usage detail.

## Cross-Repo Side Effects
None.

## Verify
- A test asserting the prompt names all four tool names (cheap drift guard: if a tool is renamed, this fails).
- Manual acceptance (the plan's end-to-end): restart the daemon, open the webapp chat, ask "What's being worked on right now across the fleet, and what needs me?" — the answer must cite tool-derived facts (ticket states, worktree contents) absent from the injected snapshot.
