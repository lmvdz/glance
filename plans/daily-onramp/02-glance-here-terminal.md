# `glance here` — terminal-attach thread on cwd

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/index.ts, src/here.ts (new), src/cli-args.ts (new), src/squad-manager.ts, src/harness-registry.ts, src/server.ts, src/schema/http-body.ts, tests/here.test.ts (new), tests/harness-registry.test.ts

## Goal

`glance here` in any terminal, in the current directory, attaches a casual thread with no setup ceremony: it prints the webapp URL, drops into a REPL in the SAME terminal, sends prompts and streams replies over the daemon's existing HTTP surface, rides the operator's own claude login/config (not the daemon's default `omp` harness), and registers the cwd as a project that disappears again when the session ends unless explicitly promoted. This is the foundation every other concern in this epic (03-06) attaches to.

## Approach

**CLI verb.** Add `case "here":` to the `main()` switch in src/index.ts (alongside the existing verb dispatch at :1022-1102 — `up`, `add`, `prompt/say`, `ask`, `open`, `doctor` are the precedent). Unlike every other non-`up` verb, `here` is NOT a fire-and-forget HTTP client call — it opens a long-lived REPL. If no daemon is reachable at `base(flags)`, `cmdHere` should offer to boot one in the background first (reuse `cmdUp`'s bootstrap, matching `postCommand`'s existing "No squad daemon on … Start one with: glance up" error at src/index.ts:210 — `here` should not just print that and quit, since the whole pitch is zero setup).

**Client-mode REPL.** src/tui.ts already has the composer pattern (Editor mount, `handleKey` router at :546, submit path at :515-528 building `{type:"prompt", id, message}` and calling `this.manager.applyCommand(...)` directly in-process) but the TUI runs IN-PROCESS against a live `SquadManager` instance — it does not exist as a network client. `glance here` needs the same input/submit shape driven over HTTP instead: reuse the Editor/input-handling module from tui.ts, but replace the direct `manager.applyCommand` call with `postCommand(flags, {type:"prompt", id, message})` (src/index.ts:200-207, the same POST /api/command path every other CLI verb already uses) and replace the in-process transcript sync with a delta-poll loop against `GET /api/agents/:id/transcript?since=<seq>` (src/transcript-delta.ts is the server-side filter behind this route; src/index.ts:687 and src/supervisor.ts:226 are existing callers of this exact endpoint to copy the polling shape from). Render deltas as they arrive — no WS dependency required for a first cut, since the CLI client can poll on a short interval the way `supervisor.ts` already does.

**Session creation.** On `here` start: `POST /api/console` equivalent — `manager.create({repo: realpathed(cwd), name: "chat", autoRoute: false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT, harness: "claude-code"})` (src/console-prompt.ts is the existing console-lane precedent; src/server.ts:2375 is the server route this reimplements as a direct manager call or a thin new endpoint). The created agent is a STANDARD worktree unit — `create → createWithId → resolveWorktree` (squad-manager.ts:4402/4651) is untouched; OMPSQ-40 stays law (squad-manager.ts:4656, `inPlace` only for non-git dirs). Non-git `cwd` is refused with a clear message pointing at `git init`, not silently downgraded.

**Harness parity — the load-bearing decision in this concern.** "Rides the claude harness on the operator's own login/config" means the registered `claude-code` ACP entry (src/harness-registry.ts:380: `npx @zed-industries/claude-code-acp` over the official Claude Agent SDK) — there is no other registered harness that reaches the real `claude` CLI's credential store. Two things must be done to this entry, not assumed:
  1. **It is currently `verified: false`.** `SquadManager.create` refuses unverified harnesses unless `OMP_SQUAD_UNVERIFIED_HARNESS=1` (squad-manager.ts:4610-4611, the concern-08 honesty gate). This concern must run the SAME smoke-verification the grok harness went through (2026-07-13, PR #147 — first vendor-pinned verified harness, degradation ladder live) against a real `claude-code-acp` binary and flip `verified: true` in the registry entry once it passes, rather than shipping the on-ramp permanently behind an env-var escape hatch.
  2. **It refuses to run nested inside another Claude Code session** (`unset CLAUDECODE` per the registry note at :380). The daemon must strip `CLAUDECODE` from the child's spawn env unconditionally when launching a `claude-code` harness process — Lars will routinely run `glance here` from inside a Claude Code session (this very session is one), and a silent refusal there is the single most likely first-contact failure.
  3. **`contextInjection: "none"`** on `ACP_CAPS` (harness-registry.ts:314-321) means the daemon cannot prepend its own system prompt into an ACP session the way it does for `omp` (`contextInjection: "native"`). This does NOT necessarily break parity — Claude Code's own agentic loop discovers `CLAUDE.md`/skills/memory from the filesystem independent of any daemon-injected prompt — but it must be TESTED, not assumed, hence the acceptance test below.

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

Executed 2026-07-16 (feat/daily-driver-w1). Everything below was driven live against a scratch daemon
(file mode, own state dir/port) with the operator's real claude login, from INSIDE an active Claude
Code session — not inferred from green tests.

**What shipped.**
- `glance here` verb (src/index.ts dispatch → src/here.ts): inline readline REPL (deliberately NOT
  the alt-screen pi-tui Editor from tui.ts — an on-ramp that hides scrollback loses to `claude` at
  turn one; tui.ts is untouched). Streams replies via a `?since=` delta poll whose cursor only
  advances past FINALIZED entries — the manager MUTATES streaming entries in place (seq fixed,
  status running→ok), so a naive cursor prints half a message and drops the rest
  (`TranscriptRenderer`, unit-tested). Pending permission requests surface inline and the next
  submit answers them (TUI's confirm mapping). Shared CLI plumbing extracted to src/cli-args.ts
  (index↔here import cycle otherwise).
- Session creation: `POST /api/console` extended with `harness` + `ephemeral` (schema/http-body.ts);
  ephemeral registration happens BEFORE create (registerProject's absolute-path/git-root/canonical
  validation is the fail-closed gate), and a failed create rolls the registration back. Tier note in
  server.ts: stays operator (unlike admin POST /api/projects) because projects() already unions
  live-agent repos — no new authority.
- Ephemeral registration: `SquadManager.ephemeralProjects` + `registerEphemeralProject` /
  `releaseEphemeralProject` / `isEphemeralProject`. Only a repo the call actually ADDED becomes
  ephemeral — an operator-registered repo is never demoted by a passing session. Released on: REPL
  exit (`POST /api/console/release`, idempotent), the daemon's own removal path (last agent on the
  repo removed), and CLEARED by `promote()` (both fresh and idempotent paths, after persist) —
  "promote makes it durable" is the one-liner the plan predicted.
- The marker is PERSISTED (`ephemeral-projects.json` sidecar next to `projects.json`), overriding
  the plan's "in-memory Set" sketch: the registration the marker must undo is durable, so the
  in-memory first cut leaked it to permanent on any daemon restart mid-session — release became a
  no-op and the removal hook could never fire (blind-review finding, fail-open). Now:
  register fails CLOSED if the marker can't be written (registration rolled back), and boot
  reconciles reloaded markers against the restored roster — session survived the restart (04's
  reattach) ⇒ marker kept for the ordinary end-of-session hooks; session died with the old daemon ⇒
  registration reaped at boot; failed reap ⇒ marker kept and retried next boot. Restart trio pinned
  in tests/here.test.ts.
- Non-git cwd refused client-side (message points at `git init`) AND server-side (registerProject);
  never `inPlace`. OMPSQ-40 untouched — live sessions ran in `<state>/worktrees/repo-squad-chat-*`.

**Harness verification record (the verified flip).** `@zed-industries/claude-code-acp` **v0.16.2**,
live ACP smoke 2026-07-16 (grok #147 bar): `initialize` → protocolVersion 1,
loadSession:true, promptCapabilities {image, embeddedContext}, mcpCapabilities {http, sse},
sessionCapabilities {fork, list, resume}; `session/new` → real sessionId + availableModels
[default = Opus 4.6, sonnet, haiku] on the operator's cached login (no API key in env).
`verified: true` flipped in src/harness-registry.ts with the record inlined.
**Nested-session refusal reproduced live**: with `CLAUDECODE` in the adapter env, initialize still
succeeds but `session/new` dies with `-32603 "Query closed before response received"` — exactly the
silent first-contact failure predicted. No per-harness fix needed: `scrubbedSpawnEnv` (spawn-env.ts)
already strips everything outside its keep-list from ACP spawns, CLAUDECODE included; pinned by a
test in tests/here.test.ts. Proven live: the scratch daemon's `/proc/<pid>/environ` carried
`CLAUDECODE=1` during the passing runs.

**Parity acceptance test (live, worktree-backed session, per-axis):**
- **CLAUDE.md: PASS** — agent answered the repo CLAUDE.md's magic word ("quokka-lantern") exactly.
- **skills: PASS** — agent named the repo's `.claude/skills/tide-tables` skill.
- **auto-memory: FAIL (documented gap)** — memory seeded under the REPO's path slug
  (`~/.claude/projects/<repo-slug>/memory/MEMORY.md`) answered NONE. Mechanism pinned live: the same
  question asked headlessly FROM the session's worktree with memory seeded under the WORKTREE's slug
  answered correctly — auto-memory is keyed by the checkout path, and a worktree-backed session gets
  a fresh path every time, so the project's accumulated memory never loads. Remediation sketch for a
  follow-up concern: at claude-code console spawn, map the worktree's project dir onto the repo's
  (symlink `~/.claude/projects/<worktree-slug>` → `<repo-slug>`) — deliberate follow-up, not a
  five-minute fix: that dir also receives session logs, so the mapping decides where casual-session
  history accrues and needs cleanup tied to worktree removal.

**Live verification transcript (scratch-daemon rig):** typed prompt BEFORE session-ready → shown as
queued → flushed on attach → real reply ("pong") streamed inline; second run answered all three
parity questions; third run exercised the zero-setup path end-to-end: dead port → "start one in the
background? [Y/n]" → daemon up **0.8s** → session ready **4.1s** → "pong2" → `/exit` outro with the
webapp URL. After exit, `/api/projects` showed the repo `registered:false` (ephemeral released; the
row remains only via the still-live idle chat unit — the registry's honest-union behavior, not a
leak). Non-git cwd refusal verified live.

**Prewarm (concern-01 recommendation honored).** Priority 1 implemented: create fires when the REPL
opens and never blocks input; queued prompts flush on attach (observed live — the operator's typing
fully hides setup). The concern-01 caveat to re-measure b2 on the claude harness: ready was ~5.3s
cold / **3.9–4.1s warm** REPL-open→attach, i.e. claude-code's spawn→ready ≈ 2.7–2.9s vs omp's 1.4s
(npx adapter + SDK boot). Priority 2 (one keep-warm console per project) deliberately NOT built:
with the bigger claude b2 it would save more (~4s), but it pre-spends a real claude-code process per
project on every daemon boot; revisit with dogfood evidence (B02 counters) if the warm 4s reads as
friction in practice.

**Independent live re-verification (2026-07-16, separate verifier, fresh scratch rig).** All five
concern-verify steps re-driven from scratch (tmux pty, throwaway repo, isolated state dir/port 8137,
file mode, real claude login, `CLAUDECODE=1` in the launching shell): cold zero-setup path (dead
port → "[Y/n]" → `daemon up (0.5s)` → queued positional prompt → `ready (4.1s)` → real reply
streamed inline); warm runs ready 4.36s/4.35s, REPL-start→reply-visible 8.3s/11.0s (above A01's
6262ms omp-lane warm dispatch→first-token — consistent with the documented claude-adapter spawn
overhead; note the measure is reply-visible, single-word replies render on finalize), follow-up
turn in a live session 3.4s (model floor). Ephemeral round-trip observed: during session
`projects.json`+`ephemeral-projects.json` both carried the repo and `/api/projects` said
`registered:true`; after every `/exit` both files were `[]` and the row degraded to
`registered:false` (live-agent union only). Worktree `<state>/worktrees/here-playground-squad-chat-*`
existed per session. CLAUDECODE scrub proven again via `/proc`: daemon env carried `CLAUDECODE=1`,
its npx→claude-code-acp child chain carried none. Deep-link `/?token=` returned 200 (SPA shell;
agent id confirmed via `/api/agents` with the same token — the shell itself is static). One
non-defect observation: the adapter PROCESS inherits the daemon's cwd (no `cwd` in the ACP
Bun.spawn), while the ACP session cwd is correctly the worktree (squad-manager.ts:5136).

**Known limits / follow-ups (named, not hidden):**
- DB-registry mode: the bearer-token CLI actor has no org, so `POST /api/console` returns
  "no active organization" (observed live when the scratch daemon accidentally booted DB-mode via the
  repo's own `.env`). Property of every CLI verb against a DB-mode daemon (root-factory routing is the
  existing escape hatch), not new here — but `glance here` is the first verb Lars will feel it on.
- Webapp deep-link: the printed URL opens the dashboard (token flow) where the chat unit is live;
  a per-session deep-link is concern 05's scope.
- Exit keeps the console unit alive (the webapp-continuation promise; also what 04's reattach needs).
  The daemon-side removal hook releases the ephemeral registration when that unit eventually goes.
