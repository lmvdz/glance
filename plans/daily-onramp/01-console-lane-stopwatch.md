# Console-lane stopwatch — throwaway dispatch→first-token measurement

STATUS: open
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

(filled in when this concern executes — cold/warm numbers + phase breakdown + prewarm recommendation go here)
