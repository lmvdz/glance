# Cold-adopt digest surfacing + system-prompt restore
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts

## Goal
When a plain (non-workflow) unit is cold-adopted after its host died, it should come back with
its prior-session context instead of amnesia:
1. Surface the last run's digest as a fenced **system transcript entry**, exactly as the
   `restart()` path already does (`src/squad-manager.ts:3813-3817`).
2. Restore the `appendSystemPrompt` (tool grants / profile memory / fabric primer) that the
   adopt `create()` call drops today.

This honors the existing invariant — *surfacing only, never auto-prompt (no silent spend)* —
so it changes no land semantics and cannot strand a unit (unlike an auto-prompt resume).

## Approach
In `adoptOrphanedAgents` (`src/squad-manager.ts:1147-1191`):

**(a) Restore the system prompt.** Add to the `create({...})` options:
```ts
appendSystemPrompt: p.appendSystemPrompt,
```
Caveat (documented, accepted): for *profiled* units this re-prepends `profile.memory`+toolGrants
at `createWithId` line 2932 (the persisted value is already-composed). Cosmetic — idempotent
content, no behavioral effect. Non-profiled units (the common fleet case) compose cleanly.

**(b) Surface the digest.** In the existing `.then(async (dto) => {...})` after `create()`
resolves, for plain adopted units only, mirror `restart()`'s surfacing:
```ts
if (p.kind !== "workflow") {
  const rec = this.agents.get(dto.id);
  const digest = await readDigest(this.stateDir, dto.id).catch(() => undefined);
  if (rec && digest) {
    this.append(rec, "system", "📒 Resume digest — prior session memory:\n" + fenceUntrusted("resume digest", digest));
    this.emitAgent(rec);
  }
}
```
Note: `readDigest`/`fenceUntrusted` are already imported (used by `restart()`). The digest is
keyed by the ORIGINAL id `p.id`, not the freshly-minted `dto.id` — verify which key
`writeDigest`/`readDigest` use (finalizeRun writes under `rec.dto.id`). If the cold-adopt mints
a new id, read under `p.id`: `readDigest(this.stateDir, p.id)`. **Resolve this before coding** —
it determines whether the surfaced digest is the right unit's.

All new async work is `.catch`-guarded (RT1-F5: an unhandled rejection here crashes the Bun
daemon).

## Cross-Repo Side Effects
None.

## Verify
- Unit test: adopt a plain PersistedAgent with a written digest → the new rec's transcript
  contains a `system` entry with the fenced digest; a workflow PersistedAgent does not.
- Unit test: adopt a PersistedAgent with `appendSystemPrompt` set → the spawned driver receives
  it (assert on the RpcAgent/driver spawn args or the persisted round-trip).
- `bun test` green (mind the PATH gotcha: `node_modules/.bin` with `omp` must be on PATH).
- Live: kill a unit's host, restart the daemon, confirm the adopted unit shows the 📒 resume
  digest entry and its child was spawned with `--append-system-prompt`.

## Resolution
Shipped. Applied to **both** fresh-id resume paths (`adoptOrphanedAgents` and the `loadPersisted`
restore loop), which had the identical `appendSystemPrompt` drop. Added `appendSystemPrompt:
p.appendSystemPrompt` to both `create()` calls and a shared `surfaceResumeDigest(newId, p)` helper
that reads the digest under the ORIGINAL `p.id` (writeDigest keys by run-time id; adoption mints a
fresh id) and appends it as a fenced `system` transcript entry for plain (non-workflow) units only.
Whole helper body is `try/catch`-guarded (RT1-F5: an unhandled detached rejection crashes the Bun
daemon). Tests: `tests/resume-digest-surface.test.ts` (3 pass — plain surfaces, workflow does not,
appendSystemPrompt round-trips). Typecheck clean; full suite 1545 pass / 0 fail.
