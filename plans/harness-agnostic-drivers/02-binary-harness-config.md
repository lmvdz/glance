# Binary/harness config end-to-end
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/index.ts, src/squad-manager.ts, src/agent-host.ts, src/harness-registry.ts

## Goal
Make the harness + binary configurable at three levels (per-harness command table, global default,
per-agent override), and fix the `bin` field that exists but is never populated in production.

## Approach
- **Per-harness command table** (on `HarnessDescriptor` from concern 01): `command(opts) => string[]`.
  omp: `["omp","--mode","rpc","--cwd",cwd, ...model/approval/thinking/appendSystemPrompt flags]`
  (today's implicit default). Registry entries carry their own argv shape (concern 04 adds pi's).
- **Global default**: read `GLANCE_HARNESS` (default `"omp"`) and `GLANCE_BIN` in the `src/index.ts`
  bootstrap and thread into `SquadManagerOptions` — the exact place `bin` already exists and is
  silently dropped (src/index.ts:329/348 omit it). This is also a **bug fix**. `GLANCE_BIN` overrides
  the default harness's argv[0].
- **Per-agent override**: `CreateAgentOptions.harness` (registry key) + `CreateAgentOptions.bin`
  (argv[0] override), threaded down the same path `bin` already threads through RpcAgent→agent-host.
- Resolution order: per-agent `harness` > `GLANCE_HARNESS` env > `DEFAULT_HARNESS`. Do NOT let `bin`
  imply a harness. Surface `--harness`/`--bin` at the CLI/TUI/webapp create paths (resolve to
  `CreateAgentOptions.harness`).
- Leave `SandboxAgentDriver`'s hardcode alone for now (concern 03 rejects sandbox+non-omp; the
  generic sandbox×harness is Phase 3).

## Verify
- Unit: `GLANCE_HARNESS=pi` (once concern 04 lands) makes a default create resolve pi's command;
  `GLANCE_BIN=/custom/omp` overrides argv[0]. A per-agent `harness` beats the env.
- Assert the bootstrap now populates `SquadManagerOptions.bin`/harness (regression against the
  never-populated field).
- `bun run check` + `bun test` green.
