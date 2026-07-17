# A silent >60s tool call still trips the ACP turn-liveness window

STATUS: done — resolved 2026-07-16 alongside 07's live re-verify fix; see Resolution below.
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

## Resolution (2026-07-16)

This was, in practice, the rest of 07: the live re-verifier reproduced 07's original `sleep 75`
failure against the real `claude-code-acp` 0.16.2 adapter precisely because of the case this concern
describes — the adapter emits exactly one `tool_call` update ("running") at shell-call start and
then goes fully quiet until completion, so 07's "reset silence on any update" mechanism only ever
gets one bump and the fixed window still trips mid-tool. Both concerns are fixed by the same change
in `src/acp-agent-driver.ts`, landed together.

**Mechanism.** `trackToolCall(toolCallId, status)` maintains a `Set<string>` of outstanding
`toolCallId`s from the `tool_call` / `tool_call_update` notification stream (any status not in
`{completed, failed, cancelled}` counts as still-open, including a missing status — conservative in
the direction of not prematurely resuming the window). On a zero↔nonzero transition it calls
`turnToolCallChange(outstanding)`, which `sendTurn` wires per-turn alongside the existing
`turnLivenessBump`: `armSilence` is a no-op while a tool call is outstanding (the silence window is
**suspended**, not just reset), and closing the last outstanding tool call re-arms a fresh window.
No outstanding tool call ⇒ the plain 60s silence window applies exactly as before (fail-closed
unchanged, per the meta standing decision "absence of evidence is never evidence of settlement"). A
tool call that opens and never closes (adapter died mid-tool) leaves the window suspended forever by
design; the unconditional 30-minute hard cap is the accepted backstop for that case — see the comment
on `armSilence`.

**Tests** (`tests/acp-agent-driver.test.ts`): a fake adapter shaped exactly like the real one — one
`tool_call`, then silence well past the test-scaled window, then the completion update + prompt
response together — must resolve (pins the live failure). A companion fake opens a `tool_call` and
then goes silent forever (no completion, no response) — only the hard cap may end that turn. The
pre-existing fully-silent-adapter test (no tool call at all) and the streams-past-silence test are
unchanged and still green, proving the fix is additive, not a loosening of the fail-closed cases.

**Live evidence** — see 07's Resolution section for the full quote; the same live run (a `sleep 75`
tool turn against the real adapter, 78s of total silence mid-tool) is the proof for both concerns:
no error transition, agent back to idle, `SLEEP_DONE` finalized in the transcript.
