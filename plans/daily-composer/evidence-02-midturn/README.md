# Evidence — daily-composer/02 mid-turn send semantics (2026-07-16)

Raw artifacts from the live drive behind 02's Resolution. Rig: isolated scratch daemon
(scratch-daemon skill) booted from branch code on port 7997, chat units on the claude-code
harness (`@zed-industries/claude-code-acp` 0.16.2 via npx, SDK-default model), commands sent
over the same WS `{type:"prompt"}` surface the webapp composer and IntervenceView steer use.

- `drive.ts` — the whole rig: session create, WS send path, 300ms transcript/status
  delta-observer, all scenarios. Re-run: boot a scratch daemon per the skill (state dir
  `/tmp/glance-scratch-owAg` or edit the two constants), then `bun drive.ts <scenario>`.
- Scenarios: `s1` send-during-generation · `s2` send-during-tool-call · `s3` rapid-fire ×3 ·
  `s4` chat-vs-steer same tick. Controls: `s0` prose turn alone · `s0num` number-list probe
  alone (trips the API content filter by itself — the reason s1's first attempt was discarded)
  · `s0tool` tool turn alone (stuck-"running" tool entries pre-exist) · `s0long` single 75s
  turn alone (the 60s `session/prompt` timeout ship-blocker, plans/daily-onramp/07).
- `<scenario>.log.jsonl` — timestamped observer stream (sends, status changes, entry growth).
- `<scenario>.transcript.json` — final full transcript dump per scenario.
- `transitions.jsonl` — the scratch daemon's entire status-transition ledger across all runs
  (includes the discarded content-filter-contaminated first s1, agent chat-mrnjbl1d).
