---
name: make-it-work
description: Drive omp-squad to actually-works — one landable fix per iteration, each one REPRODUCED and verified by running the daemon/UI/API, never trusted to green tests. Use when the user says "/make-it-work", wants to burn down things that "exist but don't actually work", or wants a loopable goal that keeps finding and fixing what lies. Built for /loop (self-paced) and the squad fleet.
---

# make-it-work — make omp-squad genuinely work, proven by running it

omp-squad typechecks clean and its test suite is green, yet features exist that **don't actually work**: endpoints that return canned data, buttons with no handler, subsystems gated off or stubbed, errors swallowed into fake success, scripts that resolve against the wrong directory. Green tests prove nothing here — many assert weak or mocked behavior. Your job is to make the product genuinely do what it claims, **one fix at a time, each proven by running it**.

This is a **LOOP**. Each iteration drives exactly ONE thing from "lies" to "genuinely works." Do not batch; do not plan ten fixes. Pick one, prove it, land it, repeat.

## The loop

1. **PICK** the single highest-value thing that doesn't actually work. (See *Where to start looking*.)
2. **REPRODUCE IT FIRST**, with your own eyes — boot the real daemon, drive the UI/API or spawn a real agent, and watch the broken behavior happen. Capture the failing evidence. **If you can't reproduce it, it is not the bug** — pick another.
3. **FIX it completely.** No stubs, no TODOs, no "table for later." Match the surrounding code's idiom. Work in an isolated git worktree.
4. **PROVE it by running.** Re-run the exact reproduction and show it now works. Then gate: `bun run check` clean **AND** `bun test` fully green (with omp on PATH) **AND** one fresh live run. A fix is done when the product does the thing — not when a test passes.
5. **LAND** one logical, self-contained commit with a clear message, then report (see *Per-iteration output*). Loop to the next.

**Stop** — and say so plainly — when no real "doesn't actually work" issue survives an honest hunt. Never invent busywork to keep the loop alive.

## Verify by RUNNING — the non-negotiable part

The entire point is to not trust the test suite. Always confirm behavior against a live daemon:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"   # REQUIRED — else `omp` isn't found; agent spawns + 2 tests fail
SD=$(mktemp -d); P=7980                        # isolated state dir + a free port (never clobber a real daemon)
OMP_SQUAD_STATE_DIR="$SD" OMP_SQUAD_PORT=$P bun src/index.ts up --no-tui --port $P &
# the startup log prints an access token + dashboard URL — grab the token:
TOKEN=...                                       # from the log line "access token: ..."
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$P/api/<endpoint>"      # exercise read APIs
OMP_SQUAD_STATE_DIR="$SD" OMP_SQUAD_PORT=$P bun src/index.ts add /path/to/scratch-git-repo \
  --approval yolo --task "<a task that forces the broken path to run>"           # spawn a real agent
```

Know the terrain (these are the traps that send you fixing the wrong thing):
- **The LIVE dashboard is the React `webapp/`** (a Vite SPA). It is served when `OMP_SQUAD_WEBAPP=1` and a built `webapp/dist` exist — that is how this deployment runs, so the webapp is what users actually see. `src/web/index.html` (hand-built vanilla JS) is the legacy fallback, served only when the flag/dist are absent. **Audit and fix the webapp, not the legacy file.** Two gotchas when verifying: (1) a stale service worker from a prior legacy visit can keep serving the old shell over the webapp — hard-reload / unregister the SW; (2) rebuild first (`cd webapp && bun run build`) or you'll be testing stale assets.
- **Background loops** (scout/observer/opportunity/dispatch) only arm when `PLANE_PROJECT_MAP` maps a repo to a project id. Use a throwaway/invalid id to make them tick without writing to the real Plane workspace. Watch them via `omp-squad automation` or `GET /api/automation`.
- When the bug is UI-shaped, drive it in a real browser (use the **agent-browser** skill), don't just read the code.
- Command/workflow nodes execute with `cwd = worktree` — a script path that works from the repo root can be dead in a target repo. Reproduce from a *different* repo, not omp-squad itself.

## What "doesn't actually work" looks like (hunt for these shapes)

- An endpoint/handler that returns hardcoded, empty, or canned data instead of computing a real result.
- A UI control (button, dropdown, row) with no `onClick`/handler, or a handler that's a no-op / `console.log` / TODO / local-only mutation that never reaches the server.
- A feature reachable only behind an env flag that's off by default, or a built artifact that doesn't exist.
- `catch {}` (or `.catch(() => fallback)`) that swallows a real error and reports success.
- A config/env flag that is read but never changes behavior (dead toggle), or a status (`"passed"`, `"verified"`) that is hardcoded rather than computed.
- A relative path / cwd assumption that holds in this repo but breaks in a worktree or target repo.

## Guardrails

- **Never weaken, skip, or delete a test to make it pass.** A test can assert broken behavior — if so, fix the behavior AND the test, and say which in your report.
- Work in an **isolated worktree**; never edit the shared main checkout while other agents run. (This repo runs autonomous daemons — `src/features.ts`, `src/plane.ts`, etc. may change under you. Rebase past it; never claim those edits as yours.)
- The **core is solid** — worktree isolation and proof-gated verify→merge→rollback land. Don't destabilize it to fix a leaf.
- Typecheck + green tests are **necessary, not sufficient**. You must have watched the product do the thing.
- Keep the blast radius to one concern per landed commit.

## Per-iteration output (3–5 lines, every pass)

```
BROKEN:   <what didn't actually work>  (file:line)
EVIDENCE: <the failing behavior you reproduced live>
FIX:      <the change, one line>
VERIFIED: <how you proved it live> · check ✓ · test <N pass/0 fail> ✓
```

## Where to start looking

- Check the project's auto-memory **known-broken** notes first (the `omp-squad-known-broken` memory) for already-confirmed defects — e.g. the live React **webapp** missing real agent kill/restart/remove + answer-a-blocked-agent controls and shipping decorative no-op buttons / orphaned components / fabricated metadata (this is the LIVE UI — high priority); the background **Automation** observability panel currently living only in the legacy `src/web/index.html` and needing a port into `webapp/`; the codefix pre-pass resolving against the wrong cwd; capability profile/workflow bindings resolving to a generic agent; trace export blocked by the vision SSRF guard; the scout's per-agent LLM call firing before dedup; stubbed reward payout / capability verifications. **Treat these as leads, not gospel — re-reproduce before fixing; some may already be done.**
- If none reproduce, **HUNT a fresh one**: boot the daemon, drive the UI + API + a real agent, and keep going until something lies. That's the next item.

Run me self-paced (`/loop /make-it-work`) or hand the current item to the squad (`/squad`) so each fix lands in its own worktree.
