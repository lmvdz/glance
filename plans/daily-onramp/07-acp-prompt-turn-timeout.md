# ACP `session/prompt` 60s timeout kills any long turn — turn-scoped liveness instead

STATUS: done — resolved 2026-07-16 by folding in 08 (outstanding-tool-call liveness); see Resolution below.
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/acp-agent-driver.ts (`send` :467 default timeout, `prompt` :490-501), tests/acp-agent-driver.test.ts

## Goal

Found live by the daily-composer/02 mid-turn drive (see that concern's Resolution, defect 1): `AcpAgentDriver.send()` defaults every JSON-RPC request to a 60-second timeout (src/acp-agent-driver.ts:467), and `prompt()` (:495) rides that default — but ACP's `session/prompt` response only arrives at TURN END. So any claude-code (or other ACP-harness) turn that takes longer than 60s wall-clock rejects with "acp request session/prompt timed out", `promptConnected`'s catcher marks the agent **error**, and the roster shows a dead unit while the adapter finishes the turn underneath and streams the reply into a permanently-"running" transcript entry nobody is accounting for.

Live proof (control s0long, scratch daemon, claude-code-acp 0.16.2): a single healthy `sleep 75 && echo SLEEP_DONE` turn — no mid-turn sends, nothing unusual — errored at exactly +60s; the reply streamed at +93s onto an agent already marked error. Real coding turns exceed 60s constantly; this is a ship-blocker for `glance here` daily use on the claude-code harness, independent of any composer semantics. Queued mid-turn sends amplify it (each queued prompt's 60s clock starts at send time and burns while it waits behind the running turn — daily-composer/02 scenario 3), but the single-turn case alone is fatal.

## Approach

- `session/prompt` must not share the request-scoped 60s default. Give it a turn-scoped budget: either effectively unbounded with a LIVENESS check (any `session/update` notification for that session resets the clock — the turn is alive as long as the adapter streams), or a generous hard cap (the existing 30-minute branch-turn cap in squad-manager is precedent) — decided at implementation against how the driver's notification plumbing exposes per-session activity.
- Keep the 60s default for genuinely request-response calls (`initialize`, `session/new`, `session/cancel` acks) — those SHOULD fail fast; only the turn-length call is special.
- On a genuine turn-liveness timeout, the existing failure path (reject → `fail(rec)`) is correct — the fix is the clock, not the handling.
- Regression test: fake ACP server that streams `session/update` notifications for >60s before responding to `session/prompt` — driver must not reject. Companion test: a server that goes fully silent must still time out (fail-closed, per meta standing decision "absence of evidence is never evidence of settlement").

## Verify

- Live: scratch daemon + real claude-code chat unit + a `sleep 75` tool turn (the exact s0long control from daily-composer/02's rig, `plans/daily-composer/evidence-02-midturn/drive.ts` scenario `s0long`) completes with the agent returning to idle and the reply entry finalized — no error transition in transitions.jsonl.
- Fail-closed: silent-adapter test proves the driver still detects a dead adapter rather than waiting forever.

## Resolution (2026-07-16)

**What the first fix missed.** The originally shipped turn-scoped liveness (silence window reset by
any `session/update`, 30-min hard cap) was correct in shape but validated against a fake ACP server
that streamed an update every 50ms for the whole turn. The live re-verifier reproduced the exact
`sleep 75` failure **twice** against the real `claude-code-acp` 0.16.2 adapter: it emits **exactly
one** `session/update` (`tool_call`, status "running") at shell-call start, then nothing — no
chunks, no progress, no keepalive — until the tool actually finishes. A single long *quiet* tool
call has no incremental output for a "reset on any update" silence window to fire on, so the fixed
60s window (now reached via one bump instead of zero) still tripped mid-tool, and the turn still
errored with "acp request session/prompt timed out". This is exactly the follow-up finding captured
in `08-quiet-tool-liveness.md` before the live re-verify even ran — 08 turned out to be the rest of
07, not a separate narrower bug.

**What this fix adds.** `src/acp-agent-driver.ts` now tracks outstanding ACP tool calls explicitly
(`trackToolCall`, keyed by `toolCallId`, driven by the `tool_call` / `tool_call_update` notification
stream) and treats "≥1 tool call outstanding" as liveness in its own right: the silence window is
**suspended** for as long as any tool call is open, not merely reset, and resumes a fresh window the
moment the last one closes (`turnToolCallChange`, wired alongside the existing `turnLivenessBump` in
`sendTurn`). A fully silent turn with **no** outstanding tool call is untouched — the 60s window
still applies exactly as before, fail-closed. The 30-minute hard cap is unconditional either way, and
is the explicit backstop for a tool call that opens and never closes (adapter died mid-tool) — see
the comment on `armSilence` in `sendTurn`.

**Live evidence.** Scratch daemon (own state dir, port 28451, real `HOME` for claude-code-acp auth,
all autonomy loops off), a chat unit created via `POST /api/console` exactly as `glance here` does
(harness `claude-code`), driven over the same WS `{type:"prompt"}` surface the composer uses, with
`sleep 75 && echo SLEEP_DONE` as the tool call:

```
[+12.3s] status {"from":"idle","to":"working"}
[+17.2s] entry {"seq":3,"status":"running","tool":"execute","head":"▸ execute: `sleep 75 && echo SLEEP_DONE`"}
[+95.1s] entry {"seq":4,"status":"running","head":"Output:\n\n```\nSLEEP_DONE\n```"}
[+95.4s] status {"from":"working","to":"idle"}
```

78 seconds of total silence between the `tool_call` update at +17.2s and the next update at +95.1s —
comfortably past the old 60s window — with no error transition. `transitions.jsonl` for that agent
confirms the full lifecycle with no error hop:

```
{"from":"starting","to":"idle","reason":"connect-ok", ...}
{"from":"idle","to":"working","reason":"task-start", ...}
{"from":"working","to":"idle","reason":"turn-progress", ...}
{"from":"idle","to":"stopped","reason":"exit-clean", ...}
```

The finalized transcript entry (seq 4, `status: "ok"`): `"Output:\n\n```\nSLEEP_DONE\n```"`.

Regression tests replacing the flattering fake: `tests/acp-agent-driver.test.ts` now includes a fake
adapter shaped exactly like the real one (one `tool_call`, then silence past the test-scaled window,
then completion + response — must resolve) alongside the existing silent-adapter (fail-closed,
unchanged) and streams-forever (hard-cap backstop) cases.
