# Tool registry, read-only classification, console flag
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/console-tools.ts (new), src/agent-driver.ts, src/squad-manager.ts, src/types.ts, src/server.ts, tests/console-tools.test.ts (new)

## Goal
New host tools can be added as self-contained `{def, handler}` objects; read-only tools run without the human gate; investigation tools are advertised to console agents only. All existing behavior (kb-search, peer-message, grant gate, generic pending path) unchanged.

## Approach
All anchors verified 2026-07-04:
1. `src/agent-driver.ts:23-30`: add `readOnly?: boolean` to `HostToolDef` (advertisement payload may strip it — the runtime doesn't need it; it's server-side metadata).
2. New `src/console-tools.ts`:
   ```ts
   export interface ConsoleTool { def: HostToolDef; handler: (ctx: ConsoleToolCtx, args: Record<string, unknown>) => Promise<string>; }
   export interface ConsoleToolCtx { manager: SquadManager; rec: AgentRecord; }
   export const CONSOLE_TOOLS: ConsoleTool[] = []; // concerns 02-05 populate
   ```
   (Type-only import of SquadManager to avoid a cycle; or define a narrow ctx interface with just the reads the tools need — prefer the narrow interface.)
3. **Console flag**: add `console?: boolean` to `CreateOptions` + `AgentRecord` + `PersistedAgent` (persistence round-trip — see how `toolGrants` persists). `src/server.ts:1259-1266` passes `console: true` in the `POST /api/console` create call.
4. **Advertisement**: `registerHostTools` (`src/squad-manager.ts:3667-3676`): for `rec.options.console`, advertise `SQUAD_HOST_TOOLS` + `CONSOLE_TOOLS.map(t => t.def)`. ACP early-return stays.
5. **Dispatch**: in `onHostTool` (`:3678-3709`), after the two built-in branches and **after** the `toolGrants` gate evaluation (order matters — a grant-restricted profile must not gain surface silently; if `toolGrants` is set and doesn't list the tool, deny as today), look up the registry: if found and `def.readOnly`, run the handler (same shape as `handleKbSearchTool` `:3713-3737`: defensive arg parse, `respondHostTool`, one-line transcript note, `recordAudit("tool.console", ...)`). Registry tools that are NOT readOnly fall through to the generic `PendingRequest` path (future-proofing; none exist yet).
6. Non-console agents calling a console tool (shouldn't be advertised, but defend): respond with an isError "not available" rather than the pending gate.

## Cross-Repo Side Effects
None (webapp gate UI unaffected — read-only tools never create pending requests).

## Verify
- `tests/console-tools.test.ts` following `tests/kb-tool.test.ts`'s `fakeRec()` pattern: console rec gets base+console defs advertised, unit rec gets base only; readOnly registry tool executes without creating a PendingRequest; grant-restricted rec is denied; ACP no-op; audit entry recorded.
- Existing `tests/kb-tool.test.ts` passes unmodified.
- `PATH="$PWD/node_modules/.bin:$PATH" bun test tests/console-tools.test.ts tests/kb-tool.test.ts` + `bun run check`.
