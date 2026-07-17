# Capability-declaration schema (network / fs / tools / MCP)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/capabilities/index.ts, tests/capability-declaration.test.ts (new)
MODE: afk

## Goal
A pack declares what it NEEDS — network egress, filesystem scope, tools, MCP servers — so the buyer can grant a
subset and the run-gate (concern 08) can enforce it. Today a pack declares only `requiredEnv`.

## Approach
Extend the `CapabilityPack` schema (`index.ts:78-99`) with optional declaration fields:
- `network: "none" | { domains: string[] }` (default `"none"` for a marketplace pack).
- `fsScope: "worktree-only" | string[]` (default `"worktree-only"`; anything wider is parsed but rejected by the
  run-gate in v1 — no safe enforcement without Phase 3).
- `mcpServers: { name, description }[]` — the pack *names* servers it wants (the actual `{command,args}` stay
  dropped per `sanitizeRepoProfile`'s existing RCE rule); the buyer approves/supplies. A pack that declares MCP is
  run-blocked in v1 (concern 08).
- Wire the existing top-level `tools[]`/`skills[]` (currently DEAD at spawn — `materializeBindings` `:615-616`
  produces bindings nothing reads) into a real declared-tool list the run-gate consults.

These are pure schema + parse additions (this concern), consumed by the run-gate (08) and the buyer-grant UI
(part of 03). The declaration is signature-covered (concern 01 signs the full manifest), so it can't be altered
post-signing.

## Cross-Repo Side Effects
None (the broker spec's listing metadata surfaces the declaration for pre-purchase display).

## Verify
- A pack declaring `network`, `fsScope`, `mcpServers`, `tools` round-trips through parse/verify with the fields
  intact and signature-covered.
- Defaults: a pack with no declaration parses as `network:none`, `fsScope:worktree-only`.
- The declared-tool list is readable by a consumer (proves it's no longer dead) — the run-gate test in 08 exercises
  it end to end.
