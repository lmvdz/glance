# Harness registry + first-class `harness` field + migration
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/harness-registry.ts (new), src/squad-manager.ts, src/types.ts

## Goal
Replace the hardcoded `makeDriver` if-chain (src/squad-manager.ts:3190-3232) with a registry keyed
by a first-class `harness`, and migrate the legacy `runtime:"omp"|"acp"` field so daemon restart
never respawns an ACP unit as omp.

## Approach
- New `src/harness-registry.ts`: `HarnessDescriptor = { name; protocol: "omp-rpc"|"acp"; makeDriver(opts): AgentDriver; command: (opts)=>string[]; capabilities: CapabilityDescriptor }` (capabilities filled by concern 03; command by concern 02). A `Map<string, HarnessDescriptor>` + `registerHarness()` + `getHarness(name)` + `DEFAULT_HARNESS = "omp"`. Each driver module registers itself (or a central `register-harnesses.ts` wires them to avoid import cycles — prefer central, since squad-manager already imports the driver classes).
- Keep the **transport × protocol** split conceptually: `kind` (workflow/flue) wraps a driver; `harness` picks the protocol+command; `sandbox` is a transport decorator. v1 only makes the plain-agent path harness-pluggable.
- `PersistedAgent.harness?: string` + `CreateAgentOptions.harness?: string` (src/types.ts). Keep `runtime` as a deprecated alias.
- **Migration choke point**: in `makeDriver` (or where `persisted` is assembled, src/squad-manager.ts:~3057), compute `const harness = p.harness ?? runtimeToHarness(p.runtime) ?? DEFAULT_HARNESS;` where `runtimeToHarness("acp")="acp-auggie"` (or the generic acp harness) and `"omp"|undefined → "omp"`. **Never read `p.harness` raw elsewhere.** makeDriver becomes: resolve `kind` wrapper (flue/workflow keep today's branches) → else registry lookup by `harness` → wrap in sandbox if `p.sandbox` (concern 03 rejects sandbox+non-omp).
- Add `harness` to `AgentDTO` (src/types.ts, ~:550) so TUI/webapp can show which harness backs a unit (trust legibility).

## Verify
- Unit: registry lookup returns the omp descriptor by default; unknown harness throws a clear error.
- **Migration test**: a `state.json` fixture with `{runtime:"acp"}` and no `harness` restores an ACP driver (not RpcAgent). A `{}` (neither) restores omp.
- `bun run check` clean; `bun test` green (mind PATH gotcha: node_modules/.bin).
