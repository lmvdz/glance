# ACP context-injection decision (the system-prompt blocker)
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: src/acp-agent-driver.ts, src/harness-registry.ts

## Goal
Resolve the CRITICAL blocker: ACP has no system-prompt slot (verified against the schema — neither
`initialize` nor `session/new` accepts instructions/systemPrompt), yet omp-squad's profile memory,
**tool-grant capability scoping**, and **cold-start fabric primer** all ride `appendSystemPrompt`.
Decide how (whether) ACP units receive context.

## Approach
Two options, decide with a live ACP binary in hand:
- **v1 — `contextInjection:"none"` (honest default).** ACP units run WITHOUT the fabric primer,
  profile memory, or tool-grant scoping. Declared in the capability descriptor, surfaced at create
  ("this harness cannot receive omp-squad context — running unscoped"). Ships immediately, lies to
  no one.
- **Real fix — `contextInjection:"mcp"`.** Route context through an MCP server the driver provides via
  `session/new`'s `mcpServers` (`acp-agent-driver.ts:188` already passes `mcpServers: []`) — the only
  spec-blessed context channel. The primer/scoping become MCP resources/tools the agent can read.
  Real work; the driver hosts (or points at) a small MCP server exposing the fabric primer + grants.
- Do NOT prepend synthetic content blocks into the first `session/prompt` (mixes trusted scoping into
  the untrusted user turn, no caching, per-adapter divergence).

## Verify
- v1: an ACP unit's create surfaces `contextInjection:"none"` and the primer is provably not sent.
- mcp: the ACP agent can read the fabric primer via the provided MCP server (live smoke).
