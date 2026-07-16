# Bind a profile to real skills via MCP servers
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/agent-profiles.ts, src/squad-manager.ts, src/acp-agent-driver.ts, src/worktree.ts (or a new mcp-config writer), tests/

## Goal
A profile can attach **operator-controlled MCP servers** so it has real, specialized capability — a "designer" profile loads design-oriented MCP servers, a "coder" profile loads code-analysis ones. The goal is to make profiles affect the actual tool surface available to each spawned agent, not just its prompt/persona: profile selection should deterministically resolve a per-unit MCP set, persist that resolved set for restart/replay, inject it into the chosen harness before the agent starts, and expose only safe server names back to operators for auditability. This is what makes profiles genuinely different at a task class, beyond persona text. Works for BOTH harness families (omp-rpc via a config file, ACP via the session channel), and is secured against the repo-config RCE class by allowing repo profiles to describe intent/persona while reserving executable MCP definitions for trusted operator/env configuration.

## Context (verified)
- `CapabilitySkillSpec`/`CapabilityToolSpec` bindings are DEAD at spawn (parsed/stored/diffable, never consumed). Only profile/workflow/driver bindings are live. So "skills" as capability tags do nothing — don't build on them for v1.
- **omp/pi read `<worktree>/.omp/mcp.json`** (project-scope MCP, confirmed in the vendored omp binary): `{ mcpServers: { "<name>": { type:"stdio"|"sse"|"http", command, args, env, cwd, url, headers, enabled, timeout } } }`. Nothing in src/ writes it today. omp is spawned with `--cwd <worktree>` (agent-host.ts:167), so it reads that path.
- **ACP**: `AcpAgentDriver.mcpServers()` (acp-agent-driver.ts:226-230) is a hardcoded `[]`; `session/new` (acp-agent-driver.ts:216) passes it. `AcpAgentDriverOptions` has no mcpServers field. Thread one in.
- `CreateAgentOptions`/`PersistedAgent` have NO mcp/skill fields — all net-new (types.ts).
- Spawn seam: `createWithId` → `resolveWorktree`/`addWorktree` (~squad-manager.ts:3195) → `makeDriver` (~3368) → `agent.start()` (~3313). Write per-unit config between worktree-cut and start().
- **SECURITY**: an MCP stdio server is `{command, args}` = arbitrary code execution — the SAME RCE class as `bin` (already fixed for repo profiles). Repo-committed profiles must NOT define inline MCP servers.

## Approach
1. **Canonical type** (src/types.ts): `McpServerSpec { name: string; type: "stdio" | "sse" | "http"; command?: string; args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string>; enabled?: boolean }`. Add `mcp?: McpServerSpec[]` to `AgentProfile`, `CreateAgentOptions`, `PersistedAgent`.
2. **Parse + SECURITY** (src/agent-profiles.ts): parse `mcp` in `parseProfiles`. For `source: "repo"`, **REJECT the entire `mcp` field** (drop + warn — mirrors the `bin` rule), because inline MCP servers are arbitrary exec/network from untrusted repo config. Only env/operator (`OMP_SQUAD_PROFILES`) profiles may attach MCP servers. (v2 can add named-reference-from-an-operator-allowlist so repo profiles can *select* but not *define* servers.)
3. **Resolve** (createWithId): `mcp: opts.mcp ?? profile.mcp` in the profile-merge block; persist on PersistedAgent.
4. **Inject — omp-rpc family**: before `agent.start()`, if the resolved harness protocol is `omp-rpc` and `mcp` is non-empty, write `<worktree>/.omp/mcp.json` = `{ mcpServers: { [name]: {type,command,args,env,url,headers,enabled} } }`. If the file already exists (repo-committed), MERGE by name (profile server wins on collision), don't clobber. Also add `.omp/mcp.json` to `<worktree>/.git/info/exclude` so daemon-injected config never pollutes the unit's commits. Put this in a small helper (e.g. `writeMcpConfig(worktree, servers)` in a new src/mcp-config.ts or worktree.ts), called from createWithId after the worktree exists.
5. **Inject — ACP family**: add `mcpServers?: unknown[]` (or `McpServerSpec[]`) to `AcpAgentDriverOptions`; thread `p.mcp` (translated to the ACP session/new server shape) through the `AcpAgentDriver` constructor in `makeDriver`; `mcpServers()` returns it instead of `[]`. Keep the translation in one place.
6. **DTO/observability**: surface the resolved MCP server NAMES (not secrets — never the env/headers) on the AgentDTO or a detail endpoint so the operator can see "this unit has servers: figma, design-system". Names only.

## Cross-Repo Side Effects
None. New optional `.omp/mcp.json` written into a unit's worktree (git-excluded).

## Verify
- Unit test: env profile with `mcp: [{name:"design", type:"stdio", command:"echo"}]` → omp-rpc unit gets `<worktree>/.omp/mcp.json` with that server; ACP unit's `session/new` receives it. A **repo** profile with an `mcp` field → dropped + warned (no file written, no server threaded). Merge test: pre-existing `.omp/mcp.json` in the worktree is merged, not clobbered; `.git/info/exclude` contains the entry.
- Test: DTO/endpoint exposes server NAMES only, never env/headers/command.
- **Live drive**: a `.glance/profiles.json`-style env profile (operator scope, since repo can't set mcp) with an mcp server → `glance add . --profile designer` → confirm `<worktree>/.omp/mcp.json` written with the server and excluded from git; confirm a repo profile's mcp is dropped in the daemon log.

## Resolution
Closed — shipped on branch feat/agent-profiles (stacks on concern 01, PR #92). `McpServerSpec` added to types.ts (`AgentProfile`/`CreateAgentOptions`/`PersistedAgent.mcp`, `AgentDTO.mcpServerNames` — names only). `parseProfiles` (agent-profiles.ts) rejects a REPO-sourced profile's `mcp` entirely (console.warn, same RCE class as `bin`); env/operator profiles keep it. `createWithId` merges `opts.mcp ?? profile.mcp`, persists it, and — new `src/mcp-config.ts` — writes `<worktree>/.omp/mcp.json` (merged by name, profile wins on collision) and idempotently appends `.omp/mcp.json` to the repo's *shared* `.git/info/exclude` (resolved via `git rev-parse --git-common-dir`, not a literal `<worktree>/.git/info/exclude` — a linked worktree's `.git` is a file, not a directory). `AcpAgentDriverOptions.mcpServers` threads `p.mcp` through `makeDriver`'s ACP branch; `AcpAgentDriver.mcpServers()` returns `toAcpMcpServer(s)` (both in mcp-config.ts, one translation site for both harness families). `CreateAgentOptionsSchema` (Effect Schema wire validation) gained the matching `mcp` field. Typecheck clean; 1705 pass (+29: 12 new tests/mcp-config.test.ts, 17 new/extended tests/agent-profiles.test.ts). Not live-driven (backend-only per instruction — operator verifies via `glance add`).

Deviations / notes:
- The ACP `session/new` `mcpServers` wire shape (env/headers as `{name,value}` arrays, `stdio` untagged vs `http`/`sse` tagged `type`) is inferred from the published ACP schema, not live-smoke-verified against a real adapter — ponytail-flagged in mcp-config.ts, matching this file's existing ACP-adjacent caveats (concern 08 gates verification).
- Found (not fixed, pre-existing, out of scope): concern 01's `harness`/`bin` fields on `CreateAgentOptions` are absent from `CreateAgentOptionsSchema` (src/schema/create-agent-options.ts) — a `create` command over the WS/POST/federation wire silently strips them (the drift-guard conditional type doesn't catch a merely-missing optional field). `mcp` was added to the schema to avoid repeating that gap for the new field; `harness`/`bin` were left alone since fixing them wasn't asked and wasn't this concern's touch surface.
