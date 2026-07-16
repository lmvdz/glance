# `glance here` — terminal-attach thread on cwd

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/index.ts, src/tui.ts, src/project-registry.ts, src/squad-manager.ts, src/harness-registry.ts, src/server.ts, tests/here.test.ts (new)

## Goal

`glance here` in any terminal, in the current directory, attaches a casual thread with no setup ceremony: it prints the webapp URL, drops into a REPL in the SAME terminal, sends prompts and streams replies over the daemon's existing HTTP surface, rides the operator's own claude login/config (not the daemon's default `omp` harness), and registers the cwd as a project that disappears again when the session ends unless explicitly promoted. This is the foundation every other concern in this epic (03-06) attaches to.

## Approach

**CLI verb.** Add `case "here":` to the `main()` switch in src/index.ts (alongside the existing verb dispatch at :1022-1102 — `up`, `add`, `prompt/say`, `ask`, `open`, `doctor` are the precedent). Unlike every other non-`up` verb, `here` is NOT a fire-and-forget HTTP client call — it opens a long-lived REPL. If no daemon is reachable at `base(flags)`, `cmdHere` should offer to boot one in the background first (reuse `cmdUp`'s bootstrap, matching `postCommand`'s existing "No squad daemon on … Start one with: glance up" error at src/index.ts:204 — `here` should not just print that and quit, since the whole pitch is zero setup).

**Client-mode REPL.** src/tui.ts already has the composer pattern (Editor mount, `handleKey` router at :546, submit path at :515-528 building `{type:"prompt", id, message}` and calling `this.manager.applyCommand(...)` directly in-process) but the TUI runs IN-PROCESS against a live `SquadManager` instance — it does not exist as a network client. `glance here` needs the same input/submit shape driven over HTTP instead: reuse the Editor/input-handling module from tui.ts, but replace the direct `manager.applyCommand` call with `postCommand(flags, {type:"prompt", id, message})` (src/index.ts:200-207, the same POST /api/command path every other CLI verb already uses) and replace the in-process transcript sync with a delta-poll loop against `GET /api/agents/:id/transcript?since=<seq>` (src/transcript-delta.ts is the server-side filter behind this route; src/index.ts:687 and src/supervisor.ts:226 are existing callers of this exact endpoint to copy the polling shape from). Render deltas as they arrive — no WS dependency required for a first cut, since the CLI client can poll on a short interval the way `supervisor.ts` already does.

**Session creation.** On `here` start: `POST /api/console` equivalent — `manager.create({repo: realpathed(cwd), name: "chat", autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT, harness: "claude-code"})` (src/console-prompt.ts is the existing console-lane precedent; src/server.ts:2375 is the server route this reimplements as a direct manager call or a thin new endpoint). The created agent is a STANDARD worktree unit — `create → createWithId → resolveWorktree` (squad-manager.ts:4402/4651) is untouched; OMPSQ-40 stays law (squad-manager.ts:4656, `inPlace` only for non-git dirs). Non-git `cwd` is refused with a clear message pointing at `git init`, not silently downgraded.

**Harness parity — the load-bearing decision in this concern.** "Rides the claude harness on the operator's own login/config" means the registered `claude-code` ACP entry (src/harness-registry.ts:380: `npx @zed-industries/claude-code-acp` over the official Claude Agent SDK) — there is no other registered harness that reaches the real `claude` CLI's credential store. Two things must be done to this entry, not assumed:
  1. **It is currently `verified: false`.** `SquadManager.create` refuses unverified harnesses unless `OMP_SQUAD_UNVERIFIED_HARNESS=1` (squad-manager.ts:4610-4611, the concern-08 honesty gate). This concern must run the SAME smoke-verification the grok harness went through (2026-07-13, PR #147 — first vendor-pinned verified harness, degradation ladder live) against a real `claude-code-acp` binary and flip `verified: true` in the registry entry once it passes, rather than shipping the on-ramp permanently behind an env-var escape hatch.
  2. **It refuses to run nested inside another Claude Code session** (`unset CLAUDECODE` per the registry note at :380). The daemon must strip `CLAUDECODE` from the child's spawn env unconditionally when launching a `claude-code` harness process — Lars will routinely run `glance here` from inside a Claude Code session (this very session is one), and a silent refusal there is the single most likely first-contact failure.
  3. **`contextInjection: "none"`** on `ACP_CAPS` (harness-registry.ts:312-318) means the daemon cannot prepend its own system prompt into an ACP session the way it does for `omp` (`contextInjection: "native"`). This does NOT necessarily break parity — Claude Code's own agentic loop discovers `CLAUDE.md`/skills/memory from the filesystem independent of any daemon-injected prompt — but it must be TESTED, not assumed, hence the acceptance test below.

**Parity acceptance test.** In a scratch-daemon session, start `glance here` in a repo with a `CLAUDE.md`, a `.claude/skills/` entry, and an auto-memory file the operator would normally have reachable. Ask the agent, over the `here` REPL, to name something only reachable via each of the three (a CLAUDE.md instruction, a skill's existence, a memory fact) and confirm it answers correctly. Any of the three that fails goes into a **documented parity-gap list** in this file's Resolution section — the concern is not "done" by shipping code that silently degrades; it is done by shipping code plus an honest list of what doesn't carry yet.

**Ephemeral project registration.** `SquadManager.projects()` (squad-manager.ts:2394+) already unions `projectRegistry.list()` (durable) with live-agent repos — so cwd appears in `/api/projects` the instant the agent exists, `registered: false`. That alone is not "ephemeral registration" in the sense arbitration §15 / RT1 A9 want: a project that survives between turns (not just while an agent happens to be alive) but vanishes again on ordinary session end. Add a small in-memory `Set<string>` on `SquadManager` (e.g. `ephemeralProjects`, NOT persisted — ephemeral-by-definition should not survive a daemon restart; 04 handles restart survival for the SESSION, not for this registration) populated by a new `registerEphemeralProject(repo)` that calls the existing `registerProject(repo)` (squad-manager.ts:2427, reusing its idempotent `projectRegistry.add()` — squad-manager.ts:2427-2461, `outcome === "added"`) and records the repo in the ephemeral set. On ordinary `here` session end (REPL exit, clean or via the daemon's own idle/finalize path), if the repo is still in `ephemeralProjects`, call the existing `unregisterProject(repo)` (squad-manager.ts:2470) to restore pre-session state — deletes nothing on disk per that method's own doc comment. When 06's promote flow succeeds for an agent whose repo is in `ephemeralProjects`, delete it from the set so cleanup no longer fires — "promote makes it durable" becomes a one-line side effect of an already-shipped call, not new machinery.

## Cross-Repo Side Effects

none (glance-desktop is untouched by this concern; the cockpit's own chat panel is a separate consumer per the fleet-first-ide program, already complete)

## Verify

- Unit: `tests/here.test.ts` — REPL client sends `{type:"prompt"}` over `/api/command` and renders transcript deltas from `/api/agents/:id/transcript?since=`; ephemeral registration add/remove round-trips through `projectRegistry` with the promote-clears-ephemeral-flag behavior covered.
- Fail-closed: a non-git `cwd` is refused, never silently run `inPlace`.
- Live: `glance here` inside a real repo (scratch-daemon skill) from a real terminal — type a prompt, see the reply stream inline, confirm the printed URL opens the SAME session in the webapp. Run once from inside an active Claude Code session to confirm the `CLAUDECODE`-unset fix actually prevents the ACP adapter's nested-session refusal.
- Parity acceptance test (above) run live; its pass/fail per axis (CLAUDE.md / skills / memory) recorded in this file's Resolution section as the documented parity-gap list.
- Harness smoke-verification: `claude-code` entry flipped from `verified: false` to `verified: true` in src/harness-registry.ts only after a live spawn+handshake succeeds against a real `claude-code-acp` binary (mirrors the grok PR #147 precedent) — record the binary version tested.

## Resolution

(filled in when this concern executes — parity-gap list and harness-verification record go here)
