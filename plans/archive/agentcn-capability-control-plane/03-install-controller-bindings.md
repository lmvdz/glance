# Install controller and runtime bindings
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `src/capabilities/*`, `src/squad-manager.ts`, `src/types.ts`, `tests/capabilities-install.test.ts`
PLANE: OMPSQ-323 — https://app.plane.so/inkwell-finance/browse/OMPSQ-323/

## Goal

Materialize approved installs into explicit runtime bindings without manual config drift.

## Approach

- Add `CapabilityInstallController` that converts an approved pack into `CapabilityBinding[]`.
- Binding types: `profile`, `workflow`, `tool`, `skill`, `driver`, `ui-action`, `preview`, `doc`.
- Each binding stores `installId`, `packId`, `version`, `checksum`, `sourcePath`, `key`, `enabled`, and `config`.
- Bindings are generated idempotently from pack content + tenant overrides.
- Disabled installs deactivate bindings but preserve audit/history.
- Removed installs preserve audit and runtime history; source artifacts are garbage-collected only when no installs reference them.
- Existing env profiles remain supported. Capability-backed profiles include origin/install id and must not silently overwrite env profile ids.

## Cross-Repo Side Effects

None.

## Verify

`bun test tests/capabilities-install.test.ts`

The test must prove install generation is idempotent, disable deactivates bindings, re-enable restores them, profile name collisions fail or require explicit override, and bindings pin pack checksum/version.
