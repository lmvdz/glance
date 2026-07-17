# Console-lane stopwatch — throwaway dispatch→first-token measurement

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: scripts/console-stopwatch.ts (new, throwaway — not shipped, not gated), src/console-prompt.ts, src/server.ts (read-only: timing instrumentation only, no behavior change)

## Goal

Answer one question before 02 is designed: how long does the EXISTING console lane take from dispatch to first visible token, split cold-daemon vs warm-daemon? The number, plus a prewarm recommendation, is the entire deliverable — this is throwaway measurement, not a shipped feature, and it never becomes a gate (arbitration §11 distinguishes this wave-0 stopwatch from the later deterministic mock-harness ratchet in plans/daily-overhead/, which IS a gate).

## Approach

- Drive the real path exactly as a `glance here` session will: `POST /api/console` (src/server.ts:2375) → `manager.create({repo, name:"chat", autoRoute:false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT})` (src/console-prompt.ts) → a prompt command over `/api/command` → poll `GET /api/agents/:id/transcript?since=` (delta filter: src/transcript-delta.ts) until the first assistant token lands.
- Write a throwaway script (`scripts/console-stopwatch.ts`, not wired into `bun test`, not part of the land gate) that:
  - Times four phases: (a) daemon-up readiness if cold-starting one, (b) `/api/console` round-trip (agent record created, harness process spawned), (c) time from create-returns to the harness's own first `agent_start`-class transcript entry (child process boot, MCP config write via src/mcp-config.ts, system-prompt composition), (d) time from harness-ready to the first assistant token appearing in the transcript delta.
  - Run twice per condition (n≥3 for signal, report median + spread, not a single sample — cold starts are noisy): cold (fresh `glance up`, first console ever created) and warm (daemon already running ≥5 min, a second/third console created against it).
  - Report the phase breakdown as a table in this concern's Resolution section below (not a separate report file) — where is the time actually going: daemon boot, harness spawn, MCP/system-prompt composition, or the harness's own model-first-token latency (the part `glance here` cannot improve, since it rides the operator's own claude harness per 02).
- No code changes to console-prompt.ts or server.ts beyond adding timing log lines if the existing transcript timestamps aren't sufficient to reconstruct the phase breakdown after the fact — prefer reading existing timestamps (AgentDTO transitions, transcript entry timestamps) over adding new instrumentation, since this is a measurement pass, not a feature.
- Delete or archive the script after the number is recorded — it is not meant to run in CI. If it proves useful as an ongoing dev tool, that is a separate, later decision (not scope creep into this concern).

## Cross-Repo Side Effects

none

## Verify

- The concern's Resolution section (below, filled in when STATUS flips to done) contains: cold dispatch→first-token median (ms) with phase breakdown, warm dispatch→first-token median (ms) with phase breakdown, and one sentence of prewarm recommendation for 02 (e.g. "keep a warm console-lane harness process per project" vs "cold start is acceptable, do not prewarm").
- No automated test — this is a one-time measurement. The acceptance bar is a real number obtained by actually running `glance up` and creating real console agents against a real daemon (scratch-daemon skill), not an estimate from reading code.

## Resolution

Measured 2026-07-16 on branch `feat/daily-driver-w1` (9bd7b38) against isolated scratch daemons
(file mode, autonomy off, Plane neutralized), default `omp` harness, prompt "Reply with the single
word: pong" (every reply was the 4-char `pong`). Driver: `scripts/console-stopwatch.ts` (throwaway —
not wired into `bun test`, not part of any gate; kept only as the reproduction recipe for this
number). n=3 per condition; phase timestamps reconstructed from the transitions log (`spawn` /
`connect-ok` reasons) + transcript entry `ts`, cross-checked against client wall clock.

**Cold (fresh `glance up`, first console ever created): median 7.7s boot→first-token, 7.2s dispatch→first-token.**

| Phase | cold1 | cold2 | cold3 | median |
|---|---|---|---|---|
| (a) daemon boot → HTTP serving + token | 538 | 538 | 894 | 538 |
| (b) `POST /api/console` round-trip | 4856 | 4737 | 4711 | 4737 |
| — b1: create→`spawn` (worktree add, MCP config, system-prompt composition) | 3289 | 3167 | 3152 | 3167 |
| — b2: `spawn`→`connect-ok` (omp child boot → RPC ready) | 1408 | 1446 | 1400 | 1408 |
| (c) create-returns → status leaves `starting` | 2 | 1 | 0 | 1 |
| (d) prompt → first assistant transcript entry | 2320 | 2870 | 2124 | 2320 |
| total dispatch→first-token (b+c+d) | 7179 | 7608 | 6836 | 7179 |
| total incl. daemon boot (a+…+d) | 7717 | 8146 | 7730 | 7730 |

**Warm (daemon up ≥ 4–6 min, 2nd/3rd console): median 6.3s dispatch→first-token — but the honest steady-state number is ~5.1–6.3s, and the breakdown matters more than the total.**

| Phase | warm1* | warm2 | warm3 | median |
|---|---|---|---|---|
| (b) `POST /api/console` round-trip | 4882 | 2546 | 2646 | 2646 |
| — b1: create→`spawn` | 3284 | 1082 | 1073 | 1082 |
| — b2: `spawn`→`connect-ok` | 1476 | 1402 | 1461 | 1461 |
| (c) create-returns → ready | 2 | 1 | 2 | 2 |
| (d) prompt → first token | 1944 | 2530 | 3614 | 2530 |
| total dispatch→first-token | 6828 | 5078 | 6262 | 6262 |

*warm1 is the FIRST console on that daemon and reproduces the cold b1 (~3.3s) exactly — ~2.2s of
worktree-lane setup is a once-per-daemon(+repo) cost, not a per-console cost. warm1 started at 250s
uptime (slightly under the 5-min stipulation); warm2/3 ran past 300s.

Where the time goes:
- **b1 worktree/prompt prep** — 3.2s first console, 1.1s each later one. Harness-independent; the biggest removable chunk.
- **b2 harness process boot → RPC ready** — ~1.4s, flat across all six runs. Harness-specific (omp; `glance here` per 02 rides the operator's claude harness, so re-measure there, but assume same order).
- **(c) is ~0 because `manager.create` only returns after the harness is ready** — the console lane already serializes spawn into the create round-trip.
- **(d) model first token** — 1.9–3.6s, noisy, median ~2.4s. This is the floor `glance here` cannot improve (same brain as typing `claude`).
- Daemon boot itself is cheap (0.5–0.9s) and usually already paid (daemon long-running).

**Prewarm recommendation for 02:** yes, prewarm — controllable overhead is ~2.6s per console
(b1 1.1s + b2 1.4s) and ~4.9s for the first console on a daemon, sitting on top of an
irreducible ~2.4s model latency; without it `glance here` at turn one is ~3× slower than the model
floor. Two complementary moves, in priority order: (1) **overlap spawn with typing** — fire
`POST /api/console` the moment `glance here` enters the REPL (before the user finishes their first
message) and queue the prompt; since (c)≈0 and create already awaits readiness, this hides the full
2.6s behind ≥2.6s of typing at zero architectural cost; (2) **pre-spawn one console-lane session per
project on daemon boot** (a keep-warm pool of exactly one, recreated after promote/adopt consumes
it), which removes the once-per-daemon 4.9s first-console hit and makes even paste-instantly turns
start at the ~2.4s model floor. A pool deeper than one is not justified by these numbers.

Incidental findings (recorded here, not fixed in this concern):
- `@oh-my-pi/pi-utils/src/env.ts` eagerly parses `process.cwd()/.env` at import time and writes
  into `Bun.env`, **overriding even an explicitly-set empty env var** (`!Bun.env[key]` treats `""`
  as unset) and **bypassing bun's `--env-file=/dev/null`**. Its parser keeps surrounding quotes when
  a trailing inline comment follows and never expands `$HOME`, so this repo's
  `DATABASE_URL="sqlite:$HOME/..." # comment` line silently boots any daemon started from the repo
  root into DB mode against a junk relative sqlite path (it creates a literal `"sqlite:$HOME/…`
  directory tree in the repo root). The scratch-daemon skill's recipe is insufficient as written;
  a scratch daemon must ALSO run with cwd outside the repo. The operator's live 7911 daemon
  (launched with `--env-file=/dev/null`, cwd = repo) reports `mode:"db"` via this same path.
- The scratch-daemon skill's `bun src/index.ts serve` verb no longer exists — the daemon verb is
  `up --port <N>`.
- `daemon.kill()` (SIGTERM via Bun.spawn) did not take the daemon down; teardown needed SIGKILL.
