# Verification, docs, parity smoke
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: README.md, docs/*, tests/*, webapp/src/**/*.test.ts, webapp/src/**/*.test.tsx

## Goal

Prove the Control Tower overhaul works end-to-end and document the changed operator behavior. This is the closeout concern after implementation, not a substitute for feature-specific tests.

## Approach

- Add/maintain focused tests introduced by concerns 01-07:
  - backend fake-frame rich transcript/tool lifecycle tests
  - transcript replay/idempotence tests
  - assistant-ui mapping tests
  - route/navigation tests
  - heat/health/inbox/governance page tests
- Run targeted root and webapp tests that cover changed files.
- Run root/webapp typechecks.
- Do one manual smoke with a live daemon only if explicitly allowed to start the app/daemon; otherwise document the exact smoke script for the operator to run.
- Update README/docs for:
  - rich Control Tower transcript/tool rendering
  - profiles/model selector semantics
  - issue workspace/context-aware agent
  - real observability/heat/health data sources
  - governance/federation/onboarding truth states
- Delete obsolete sample/static data docs or mark fixtures as test-only.

## Cross-Repo Side Effects

None.

## Verify

- Root targeted tests pass.
- Webapp targeted tests pass.
- Root `check` and webapp `typecheck` pass.
- No production import of fake `heat-data` sample arrays remains.
- README matches live UI behavior and does not promise APIs that do not exist.
