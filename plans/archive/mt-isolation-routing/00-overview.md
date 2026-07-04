# MT isolation integration-test coverage

## Outcome

- The MT isolation runtime gets the two missing live-server integration tests from `plans/mt-isolation/03-request-routing.md`.
- REST routing proves org scope comes from the better-auth session, not request params.
- WebSocket fan-out proves org buckets do not leak roster, agent, or transcript events across tenants.
- No production code changes; test coverage only.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 REST request routing | Locks down session-derived org routing for `/api/agents`, including ignored `?org=` and no-active-org behavior | mechanical | `tests/routing.test.ts` |
| 02 WebSocket org isolation | Locks down per-org socket buckets and transcript subscription isolation on one live server | architectural | `tests/ws-org-isolation.test.ts` |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 0 | 01, 02 | Separate test files; both depend only on existing server/registry behavior and the research brief. They can run in parallel if each keeps its tiny harness local. |
| 1 | Verification gate | Run the requested full gate after both tests land. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 REST request routing | none | `test ! -f tests/routing.test.ts` before starting, or read it if another agent already created it |
| 02 WebSocket org isolation | none | `test ! -f tests/ws-org-isolation.test.ts` before starting, or read it if another agent already created it |
| Verification gate | 01, 02 | `test -f tests/routing.test.ts && test -f tests/ws-org-isolation.test.ts` |

## Notes

- Source brief: `plans/mt-isolation-routing/BRIEF.md`.
- Keep the live `SquadServer` path. Stub only the structural `AuthInstance` and test-only manager shape needed by `ManagerRegistry`.
- Prefer local test helpers over a shared test harness file; two files do not justify a new abstraction unless the implementation becomes noisy.
- Do not spawn real agents. Seed fake manager-shaped objects behind a real `ManagerRegistry` or otherwise avoid `create()` paths that launch runtimes.
- Final required gate: `bun run check && bun test`.

## Plane tracking

- Module: [MT Isolation Routing](https://app.plane.so/inkwell-finance/projects/1eb181ba-f324-4767-a6d5-98953d5df011/modules/a2a7e7ff-d6be-4046-acbf-b6042315f72b/)
- Issues:
  - [01-rest-request-routing](https://app.plane.so/inkwell-finance/browse/OMPSQ-396/) — OMPSQ-396 ✅ done (commit 2edcfe2)
  - [02-ws-org-isolation](https://app.plane.so/inkwell-finance/browse/OMPSQ-397/) — OMPSQ-397 ✅ done (commit c3fce10)
