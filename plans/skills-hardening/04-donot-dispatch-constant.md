# Evergreen Do-Not block in every dispatched unit's prompt
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/agent-profiles.ts, src/squad-manager.ts, tests/ (new unit test)

## Goal
Every unit spawn — profiled or profile-less, dispatched or ad-hoc — carries a short evergreen Do-Not block distilled from the repo's recorded recurring failure modes, phrased to name the agent's rationalization (the negative-space-spec pattern from the research brief).

## Approach
Export a `DO_NOT_BLOCK` constant (~10 lines, precedent: `VERDICT_FIRST_BLOCK` in src/agent-profiles.ts:181) and join it in the **unconditional** `appendSystemPrompt` composition in the spawn path (src/squad-manager.ts:4460-4473, alongside primer + authored-spec joins) — explicitly NOT via `profile.memory` (src/squad-manager.ts:4424-4439 only runs `if (profile)`; dispatched units pass no profileId — the same delivery bug R3 fixed for the primer). Mirror the `hasPrimer` scorecard flag (squad-manager.ts:4462) with `doNotsInjected`.

Content: distill from failure-memory annotations + memory lessons — candidates: chunk-size warning is known-benign, don't report it; two verify-loop failures on the same unit = escalate, don't thrash; a passing suite is not proof the gate ran — check the run marker; `git grep` alternation needs `-E`; rtk mangles grep output — verify null results with a real grep; never bare `git stash` in shared checkouts. Keep each line "Do not X just because Y" shaped where the rationalization is known. Include one pointer line appended only when the unit's task/issue text mentions Effect: "This repo pins effect@<resolved>; load `.claude/skills/effect` before writing Effect code — its examples are compile-proven at that pin."

Cap the block at ~600 tokens; it is static repo-authored text, so no untrusted fence needed (unlike the primer, which fences fabric-derived content).

## Cross-Repo Side Effects
None.

## Verify
Unit test: `create()` with no profileId (the dispatchSpawn shape, squad-manager.ts:4450-4455 documents the arguments) produces an appendSystemPrompt containing the Do-Not block; with a profile, block appears exactly once. Live: scratch-daemon spawn, inspect the composed prompt via the flight-recorder/session file for a dispatched unit.
