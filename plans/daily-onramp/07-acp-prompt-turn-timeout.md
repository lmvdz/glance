# ACP `session/prompt` 60s timeout kills any long turn — turn-scoped liveness instead

STATUS: reopened — live re-verify 2026-07-16 reproduced the exact `sleep 75` acceptance turn erroring at 60002ms, twice; see plans/daily-driver/00-meta.md Ledger. Root cause: the real claude-code-acp adapter sends no `session/update` between a tool call's start and its completion, so the silence-timer reset has nothing to fire on during a single long call with no incremental output — the shipped regression test only exercises a fake adapter that streams updates throughout, which doesn't match this.
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
