# ClientCommand `source` field → audit log
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, src/schema/client-command.ts, src/squad-manager.ts, tests/

## Goal
A voice-originated command must be distinguishable from a typed one in `audit.jsonl`. Today `appendAudit({actor, action, target})` (squad-manager.ts:4838-4841) records the socket actor only — an auditor cannot tell a spoken `spawn` from a typed one, and since voice audio never transits the daemon (by design), the fact-of-voice-origin would be recorded nowhere at all.

## Approach
- Add optional `source?: "voice" | "composer" | string` to the `ClientCommand` union members that mutate (`prompt`, `create`, `commission`, `interrupt`, at minimum — cleanest is the shared base if one exists in src/types.ts:1381-1396).
- **The field must be added to the Effect Schema** in src/schema/client-command.ts — `Schema.Struct` strips unknown keys, so a client-side-only tag would be silently dropped at `decodeClientCommand` (server.ts:774-819) and the audit would stay blind while looking wired. This silent-strip trap is the red-team finding; a test must pin that a wire frame carrying `source` survives decode with the field intact.
- Thread it into the audit write: include `source` in the appendAudit record (squad-manager.ts:4838).
- No behavior change anywhere else: `source` is observability, never authz — tiers keep gating on the actor.

## Cross-Repo Side Effects
None. Additive optional field; existing clients that don't send it are unaffected.

## Verify
- Test: decode a `{type:"prompt", id, message, source:"voice"}` frame → decoded object retains `source`; applyCommand writes an audit entry containing `source:"voice"`.
- Test: a frame without `source` behaves exactly as today (field absent in audit entry, not null-polluted).
- `bun test` green.

## Resolution
Shipped (commits ec596e6, a16b1b2, and audit-hardening 593bc16). `source` is schema-carried on mutating ClientCommands and reaches the REAL `audit.jsonl` via `recordAudit` (the first pass only hit the DB-mode store — caught in review). Extended in the audit gauntlet to cover `spawn_agent` (SpawnBodySchema + /api/spawn) and `interrupt`, so all 3 mutating voice verbs are tagged, not just `prompt`. Written-line tested.
