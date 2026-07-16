# A silent >60s tool call still trips the ACP turn-liveness window

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/acp-agent-driver.ts, tests/acp-agent-driver.test.ts

## Goal

Follow-up to `07-acp-prompt-turn-timeout.md` (fixed: turn-scoped liveness, `session/update` resets a 60s silence window, 30-min hard cap). Re-review finding N1 (fable, fix-wave re-review 2026-07-16): a single long *quiet* tool call — a silent three-minute build, a `sleep 300`, a network fetch with no progress output — emits no `session/update` between `tool_call` and its completion, so the silence window trips and fails a healthy turn. Strictly narrower than the pre-07 bug (which killed every >60s turn regardless of activity), but the same failure family survives in the no-output lane.

## Approach

Options at implementation (pick against the adapter's real event stream, observed live):
- Treat an *outstanding tool call* as liveness: on `tool_call` start, suspend or lengthen the silence window until its completing update arrives; the 30-min hard cap still backstops a tool that never returns.
- And/or count adapter stderr/keepalive traffic as liveness bumps if the ACP adapter emits any.
- Keep the silent-dead-adapter case fail-closed: no outstanding tool call AND no updates ⇒ the existing 60s window still applies unchanged.

## Verify

- Regression test: fake server emits `tool_call`, then nothing for > the (test-scaled) silence window, then the tool-completion update and the prompt response — the driver must NOT reject.
- Existing 07 tests unchanged and green: streaming resets still work; fully-silent server (no outstanding tool) still times out; hard cap still fires.
- Live: a real `glance here` turn running a quiet `sleep 90` completes without an error transition.
