# Candidate drafting (throttled)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/factory-author.ts, src/dispatch.ts, src/architect.ts, src/smart-spawn.ts, src/capabilities/index.ts

## Goal
For an `open` demand, draft a candidate capability manifest plus a demand-specific acceptance assertion, static-verify it, and move the demand to `proposed` — all within a hard spend budget. This is a *drafting* step, not an execution gate: no `runCapability`, no enable.

## Approach
- Create `src/factory-author.ts`. For a demand, spawn a drafting agent (reuse the `src/architect.ts` / `src/smart-spawn.ts` fast-model pattern — `omp -p --smol` class) prompted to emit a `CapabilityPack` manifest whose binding type matches the demand: `skill`/`doc` for `proceduralize`/`fix-churn`, `profile` for `profile-tune`. The agent also drafts a **demand-specific acceptance assertion** in plain text (what "this capability satisfied the demand" would look like) — stored on the candidate for the human reviewer and as the seed for v2's behavioral gate. Do NOT author a `runProof` command and call it a fitness function (red team A#2).
- **Static verify only:** run `verifyCapabilityPack` (schema/compat/path-safety, already exists) on the drafted manifest; reject malformed candidates before proposing. This is the only automated gate in v1.
- **Throttle (red team A-Q1 — `create()` bypasses the WIP cap):** route the drafting spawn through `src/dispatch.ts` so it counts against `OMP_SQUAD_MAX_WIP` and honors the rate-limit pause. Add a hard per-tick candidate budget (`OMP_SQUAD_FACTORY_MAX_DRAFTS`, small, e.g. 2) and a wall-clock kill on the drafting agent. The factory must never call `this.create(...)` directly.
- On success: attach the drafted manifest + acceptance assertion + evidence to the demand and transition it to `proposed` (Concern 02 state machine). The manifest is NOT installed — it's surfaced for human authoring in Concern 05.

## Cross-Repo Side Effects
Consumes dispatch capacity — verify the factory drafts yield to real units (dispatch already pauses under load/rate-limit; confirm the factory path observes it).

## Verify
- A `proposed` demand carries a `verifyCapabilityPack`-passing manifest + an acceptance assertion + evidence.
- A malformed manifest is rejected and the demand stays `open` (or `dismissed` after N failures), never `proposed`.
- Under a low `OMP_SQUAD_MAX_WIP`, factory drafting does not spawn beyond the cap; a hung draft is killed at the wall-clock limit.
- `bun test` green.
