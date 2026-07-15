# Attempt effect bump to latest v4 beta
STATUS: done
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

## Resolution (2026-07-15)
Landed `effect` `^4.0.0-beta.93` → `^4.0.0-beta.98` (latest published 4.0.0 beta as of 2026-07-13; beta.98 shipped the same day as 3.21.5/3.22.0). Also bumped the companion `@effect/language-service` `^0.86.4` → `^0.87.0`; its tsc patch step ran cleanly.

**Nothing broke.** Zero src/** changes were needed:
- `bun run check` (tsc for repo + webapp) green with no edits.
- Full `bun run test`: 3042 pass / 1 fail / 1 error across 3043 tests — both anomalies verified PRE-EXISTING at the beta.93 baseline by rolling deps back and re-running:
  - `tests/resume-digest-surface.test.ts:150` ("cold-adopt restores the original appendSystemPrompt") fails deterministically at baseline too — the Do-Not learning ledger gets appended to the persisted appendSystemPrompt, so the "round-trips verbatim" expectation breaks. Environment/ledger issue, not effect. Tracked separately.
  - `tests/acp-agent-driver.test.ts` "Unhandled error between tests: acp agent exited" is an intermittent flake (fired 2/5 baseline runs in isolation); all 6 tests in the file pass every run.
- `bun test tests/skills-verify.test.ts`: 21 pass / 0 fail (no skill carries a `verified-against` stamp yet, so no re-stamp needed; when 02 lands it should stamp against beta.98).
- webapp has no effect dependency (own dep tree, unaffected).

Transitive shifts in bun.lock (effect's own deps): fast-check ^4.8.0→^4.9.0, msgpackr ^2.0.1→^2.0.4, multipasta ^0.2.7→^0.2.8, toml ^4.1.1→^4.1.2, uuid ^14.0.0→^14.0.1. Daemon boot smoke is deferred to the plan's audit phase per the plan.
