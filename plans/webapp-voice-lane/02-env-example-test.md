# Env-catalog completeness test (close a standing false claim)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: tests/env-example.test.ts, .env.example

## Goal
`.env.example:9-12` claims "kept complete by tests/env-example.test.ts" — that file has never existed (no file, zero commits in `git log --all`). Write it for real, so the voice lane's new `OMP_SQUAD_VOICE_*` vars (concern 05) land under an actual gate and the false claim is closed.

## Approach
- Bidirectional check: every env var read in `src/` (scan for `process.env.X`, `envBool("X")`, `envInt("X")`, `envNumber("X")` — the readers live in src/config.ts) appears in `.env.example`, and every `.env.example` entry is read somewhere in `src/`. `scripts/`-only pilot vars (e.g. `ARCHIL_*`) exempt.
- Run the check locally FIRST. Pre-existing drift is likely; fix genuine gaps in this concern's commit (it's a catalog update, not scope creep), but if drift is large or contentious, split: land the test with an explicit, commented known-gaps allowlist and file the cleanup separately. Do not weaken the test's shape to pass.
- Respect `src/env-compat.ts` (GLANCE_* aliases) — don't double-count aliases as missing entries.

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/env-example.test.ts` green.
- Mutation check: temporarily add `envBool("OMP_SQUAD_DOES_NOT_EXIST", false)` to a src file → test fails; remove → passes.

## Resolution
Shipped (commit 541b82a). `tests/env-example.test.ts` is a real bidirectional gate; ~90 pre-existing undocumented env vars cataloged; one intentional gap (`OMP_SQUAD_HEAT_HALFLIFE_MS`) allowlisted with a rot-test. Mutation-checked. The standing false claim at `.env.example:9` is now true.
