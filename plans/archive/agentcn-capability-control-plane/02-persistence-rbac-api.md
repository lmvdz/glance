# Tenant persistence, RBAC, and lifecycle APIs
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `src/capabilities/*`, `src/dal/store.ts`, `src/db/*`, `src/server.ts`, `src/authz.ts`, `tests/capabilities-api.test.ts`
PLANE: OMPSQ-322 — https://app.plane.so/inkwell-finance/browse/OMPSQ-322/

## Goal

Persist capability sources/packs/installs per org and expose RBAC-gated lifecycle APIs with audit events.

## Approach

- Extend persistence with capability snapshots in file mode and DB mode. Keep org isolation aligned with `ManagerRegistry` state boundaries.
- Lifecycle states: `imported`, `validated`, `approved`, `enabled`, `disabled`, `failed`, `removed`.
- Add APIs:
  - `GET/POST /api/capability-sources`
  - `GET /api/capability-packs`
  - `GET /api/capability-packs/:id`
  - `POST /api/capability-installs`
  - `PATCH /api/capability-installs/:id`
  - `GET /api/capability-audit`
- RBAC: viewer can list/read; operator can run enabled capabilities later; admin imports/approves/enables/disables/upgrades/removes.
- Audit every lifecycle transition with actor/org/source/pack/version/checksum.
- Do not execute anything in this concern.

## Cross-Repo Side Effects

DB migrations or table definitions may be needed if the existing DB layer stores typed org tables separately from `Store` snapshots.

## Verify

`bun test tests/capabilities-api.test.ts`

The test must prove org A cannot read org B sources/installs, viewer cannot mutate, admin can import/approve/disable, and audit rows are recorded.
