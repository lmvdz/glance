# Elevate AgentProfile to a full capability bundle + secure project catalog
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/agent-profiles.ts, src/squad-manager.ts, src/harness-registry.ts, tests/

## Goal
A profile can select a full `{harness, bin, model, thinking, skills, persona, approval}` bundle, applied when a unit is created. Profiles load from a shareable project catalog `.glance/profiles.json` in addition to env — with repo-committed profiles capability-restricted so they can't run arbitrary binaries.

## Context (verified current-main line refs)
- `AgentProfile` (src/types.ts:522): `{id,name,description,runtime:AgentKind,model,approvalMode,capabilities[],memory,default}`. `runtime` is `AgentKind` ("omp-operator"|...), NOT a harness, and is **never read** in create. No `harness`/`bin`/`thinking` field.
- `parseProfiles` (src/agent-profiles.ts:42-69) parses the env `OMP_SQUAD_PROFILES` JSON array; `profileOptionsFromEnv` (29-40) adds a default. `SquadManager.profiles()` (squad-manager.ts:1567) merges env profiles + capability profiles.
- `createWithId` (src/squad-manager.ts:3021-3040) applies `model`/`approvalMode`/`memory`(→appendSystemPrompt)/`capabilities`(→toolGrantsPrompt) — NOT harness. `const kind` @3132; harness resolved @3137 via `resolveHarness({harness: opts.harness, runtime: opts.runtime})` — reads `opts`, never the profile.
- Harness registry: `resolveHarness`, `resolveBin`, `HarnessDescriptor.capabilities: CapabilityDescriptor{modelSwitch,thinking,...}`, `.verified` (src/harness-registry.ts). `bin` flows unchecked to `Bun.spawn` (agent-host.ts:167) — repo-settable `bin` = RCE.

## Approach
1. **src/types.ts** — add to `AgentProfile`: `harness?: string; bin?: string; thinking?: ThinkingLevel;`. Keep `runtime` (vestigial; leave as-is, add a comment it's superseded by `harness`). (`persona` already = `memory`; `skills` already = `capabilities` for v1 — the deep skill/MCP binding is concern 03.)
2. **src/agent-profiles.ts** — `parseProfiles` reads the 3 new fields. Add a **`source: "env" | "repo"`** parameter (or a separate `parseRepoProfiles`) so repo-sourced profiles are sanitized: **drop `bin` entirely and reject `harness` that isn't a *verified* registered harness** (call the registry), emitting a `console.warn`/daemon-log line naming the rejected field. Env profiles keep full trust (bin allowed). Add `loadRepoProfiles(repoRoot: string): AgentProfile[]` reading `<repoRoot>/.glance/profiles.json` (tolerate missing file → []).
3. **Merge** — `SquadManager.profiles()` / a new `profilesForRepo(repo)` merges: repo catalog (base) ← env `OMP_SQUAD_PROFILES` (override by id) ← capability profiles. Since profiles are consumed at create time with `opts.repo` in scope, resolve the repo catalog from `opts.repo` in `createWithId`/`profileFor`. (If threading repo through `profileFor` is heavy, load the repo catalog in `createWithId` directly and merge before `profileFor` lookup.)
4. **src/squad-manager.ts createWithId** — in the profile-merge block (3032-3040), also set `harness: opts.harness ?? profile.harness`, `bin: opts.bin ?? profile.bin`, `thinking: opts.thinking ?? profile.thinking`. This flows into the existing `resolveHarness({harness: opts.harness, ...})` @3137 and `makeDriver` — no makeDriver change needed.
5. **Capability validation** — when a resolved profile sets `thinking` but the resolved harness has `capabilities.thinking === false` (or `model` with `modelSwitch === false` on a non-omp harness where model can't be set post-spawn), reject at create with a clear error (or warn + drop the unsupported axis). Reuse the registry's `CapabilityDescriptor`. Keep it loud, not a silent no-op.

## Cross-Repo Side Effects
None (single repo). New optional file `.glance/profiles.json` is read if present.

## Verify
- Unit test: an env profile with `harness: "opencode"` → a created unit's DTO/PersistedAgent carries `harness: "opencode"` and `makeDriver` picks the ACP driver. An env profile with `bin` is honored; a **repo** profile with `bin` is dropped + warned; a repo profile with an unverified `harness` is rejected + warned.
- Unit test: profile `thinking` on a `thinking:false` harness → loud error/warn, not silent.
- Merge test: repo catalog + env override by id resolves as specified.
- **Live drive**: write a `.glance/profiles.json` with a safe profile, `glance add . --profile <id>` (or the existing `--profileId` path), confirm the unit spawns on the profile's harness/model. (If no `--profile` CLI flag exists, add one mirroring `--harness`.)

## Resolution
Closed — shipped on draft PR #92 (branch feat/agent-profiles). AgentProfile gains harness/bin/thinking; createWithId wires them into resolveHarness/makeDriver; `.glance/profiles.json` project catalog merged with env; repo profiles capability-restricted (bin dropped, unverified harness rejected — RCE fix); thinking-vs-capability loud gate; CLI `--profile`. typecheck clean, 1687 pass (+11). Live-driven: `--profile designer` applied harness/model/thinking/persona (persisted state confirmed); malicious repo profile's bin dropped + codex rejected (daemon log). Deviations: extended `profiles(repo?)` instead of a new method; `/api/profiles` route not yet repo-aware (UI picker won't surface repo-catalog entries — follow-on); model needs no capability gate (always pre-spawn).
