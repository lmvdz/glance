# Manifest-driven webapp capability UI
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: `webapp/src/lib/dto.ts`, `webapp/src/lib/api.ts`, `webapp/src/hooks/useSquad.ts`, `webapp/src/context/TaskContext.tsx`, `webapp/src/components/*`, `webapp/src/lib/*.test.ts`
PLANE: OMPSQ-325 — https://app.plane.so/inkwell-finance/browse/OMPSQ-325/

## Goal

Render capability catalog, install state, and run actions in the new starter-look UI without importing legacy dashboard components.

## Approach

- Add DTOs for `CapabilitySource`, `CapabilityPack`, `CapabilityInstall`, `CapabilityBinding`, validation warnings, and version diffs.
- Add API helpers for capability routes.
- Add a `Capabilities` surface using the existing visual language: sidebar entry, list/detail split, compact cards, install-state badges, warning rows, source/version metadata, and action chips.
- Admin view: source management, manifest validation, install/enable/disable/upgrade/rollback actions, audit trail.
- Operator view: enabled capability-backed workflows/profiles/actions, starter prompts, preview/artifact panels.
- Render recipe docs/previews from manifest metadata. Do not hardcode capabilities in React except built-in seed source metadata.
- Preserve AssistantChat behavior: chat stays interactive; explicit capability run starts a capability-backed workflow/profile.

## Cross-Repo Side Effects

None.

## Verify

`cd webapp && bun run typecheck && bun test`

Add focused tests for DTO mapping and UI state helpers. Do not run `dev`/`build` unless explicitly requested.
