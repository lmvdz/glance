# Canonical autonomy mode contract
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/server.ts, src/index.ts, src/tui.ts, webapp/src/lib/dto.ts, webapp/src/components/*

## Goal

Make run authority explicit and visible everywhere: `observe`, `assist`, or `autodrive`.

## Approach

- Add persisted `autonomyMode`, computed `effectiveMode`, `verificationState`, proof ref/fingerprint, blocked reason, and available actions to DTOs.
- Add explicit mode transition command/API with actor, old mode, requested mode, effective mode, reason, and audit record.
- Define the effective-mode matrix against existing `approvalMode`, `autoLand`, `landConfirm`, and env defaults. Reject contradictory combinations or cap downward.
- Move authorization checks to manager/service methods; REST/workflow/scheduler/TUI must not bypass mode checks by calling lower-level helpers directly.
- Treat env vars as boot defaults/caps, not live policy truth.

## Cross-Repo Side Effects

The web dashboard DTO and controls must be updated to render mode/proof state and disable impossible actions.

## Verify

- Add tests for mode transition authorization and effective-mode computation.
- Add API/server tests proving direct verify/land/create routes honor mode checks.
- Add a web DTO/type check covering new fields.
