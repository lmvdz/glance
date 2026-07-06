# Harden AcpAgentDriver into the universal ACP on-ramp
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/acp-agent-driver.ts, src/harness-registry.ts

## Goal
Turn the experimental `AcpAgentDriver` (9 ponytail TODOs, hardcoded `auggie --acp`) into one driver
parameterized by the harness command table, serving gemini-cli, opencode, claude-code (via
`claude-agent-acp`), and codex (via `codex-acp`).

## Approach
- **Command parameterization**: replace `buildAcpCommand` with the registry command table —
  `gemini --acp`, `opencode acp`, `npx -y claude-agent-acp@<pin>`, `codex-acp@<pin>`. One class, N
  entries = the real "N harnesses, one driver" win.
- **Close the SETTLED ponytails** (spec-verified): framing is newline-delimited per the ACP transport
  spec (the `pumpStdout` splitter is correct; drop the Content-Length ponytail). Permission kinds are
  the fixed enum `allow_once|allow_always|reject_once|reject_always` (prefix match is correct).
- **Fix `pickOption` to fail CLOSED**: when no option `kind` matches (kind-less adapter option), do
  NOT fall back to `options[0]` (fail-open coin-flip) — reject. Add a per-harness `permissionQuirks`
  hook for adapters that emit nonstandard kinds.
- Usage translation: verify `parseUsage` field names against a real `usage_update` (concern 08).
- Capabilities (concern 03): ACP harnesses = `{ hostTools:false, toolApproval:"native", resumable:false (concern 07), modelSwitch:false (unstable_), thinking:false, contextInjection: per concern 06 }`. Narrow after `initialize` negotiation.

## Verify
- Unit against a fake ACP server (the injectable `command` already supports this): initialize →
  session/new → prompt → session/update stream → session/request_permission → respondUi picks the
  right option; a kind-less option is rejected, not silently allowed.
- `grep -c ponytail src/acp-agent-driver.ts` drops materially; `bun run check` + `bun test` green.
- Live smoke (concern 08) for whichever ACP binaries are installable.
