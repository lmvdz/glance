# Attempt effect bump to latest v4 beta
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: package.json, bun.lock, src/** (only where the bump breaks), .claude/skills/effect/* (stamp re-run if 02 landed)

## Goal
The repo's `effect` pin moves from `^4.0.0-beta.93` to the latest v4 beta (≥ beta.97, upstream skill's review target) — shrinking the vendored skill's adaptation delta to near zero and staying current on the beta line we must cross before v4 stable anyway.

## Approach
Timeboxed attempt (half a day): bump `package.json`, `bun install`, run `bun run check && bun run test` in a pristine worktree (only a fresh pristine worktree counts as a gate run — composition-drift lesson), fix mechanical breaks. Review effect's beta.93→target changelogs for the runtime-semantic classes tsc misses (defaults, renamed-but-aliased behavior). If breakage exceeds the timebox, STOP: record findings in this concern, set STATUS blocked with the specific blockers, do not force. If 02 already landed, re-run `bun run scripts/skills-verify.ts --stamp` in the same PR (the gate hard-fails on stale stamps by design — this coupling is documented, not accidental).

Deliberately NOT blocked_by / blocking anything: 02 adapts to whatever pin is resolved at vendor time; either order is correct, this one first is merely cheaper.

## Cross-Repo Side Effects
None (webapp has its own dep tree; check whether webapp/package.json pins effect — if so, bump in the same PR).

## Verify
`bun run check && bun run test` green in a pristine worktree; daemon boots and serves (`bounce` skill's health probe); skills-verify gate green with re-stamped `verified-against`.
