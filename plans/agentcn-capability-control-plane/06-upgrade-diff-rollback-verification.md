# Upgrade, diff, rollback, and verification records
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `src/capabilities/*`, `src/server.ts`, `webapp/src/components/*`, `tests/capabilities-upgrade.test.ts`

## Goal

Make capability upgrades safe: staged versions, manifest diffs, verification records, and atomic rollback.

## Approach

- Store multiple pack versions side-by-side while installs reference one active checksum.
- Add manifest diff engine that classifies changes: instructions, tools, skills, workflows, dependencies, context policy, UI metadata, docs-only.
- Require admin approval for risky changes; optionally allow docs/UI-only updates to fast path.
- Add `CapabilityVerification` records for schema validation, compatibility checks, dependency review, permission review, runtime smoke, and security review.
- Upgrade flow stages new bindings, runs validation, then atomically switches active install version.
- Rollback reactivates the previous binding set; audit records reason and actor.
- UI shows diff and risk badges before approval.

## Cross-Repo Side Effects

None.

## Verify

`bun test tests/capabilities-upgrade.test.ts`

The test must prove diffs classify risky fields, upgrades do not mutate current bindings until approved, rollback restores prior checksum, and audit/verification records exist.
