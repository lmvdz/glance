# Membrane disciplines — verdict-first + minimal-code, measured, auto-reverting
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 02
TOUCHES: src/validator.ts, src/agent-profiles.ts, src/planner.ts, src/runtime-settings.ts, tests/

## Goal
Prompt-only output disciplines exist where they're safe and measurable: judges/planner get
verdict-first blocks now; implementer units can opt in via profile tokens that are delivered
native-only, stamped only on confirmed delivery, double-gated, and auto-disabled on a measured
success drop.

## Approach
- Author two glance-native blocks (concepts from EAP, text ours): verdict-first (never applies to
  safety refusals, destructive-action warnings, or error text — byte-exact carve-outs) and
  minimal-code ladder (7 rungs, hard carve-outs: input validation, data-loss handling, security,
  one runnable check per non-trivial path).
- v1 placement: validator judge/lens SYSTEM prompts and planner prompt — output-shaped surfaces,
  no completeness norms at risk.
- Profile tokens (`membrane:verdict-first`, `membrane:minimal-code`) for implementer units:
  - CRITICAL: expanded via a SEPARATE channel from `capabilities[]` — membrane tokens must never
    enter toolGrants (capabilities is the host-tool allow-list; squad-manager.ts:3622 + :6757).
    Filter membrane:* out before both the grants computation and the tool-list prompt. Test:
    membrane-only profile keeps toolGrants === undefined.
  - Native contextInjection harnesses only in v1 (omp, pi); ACP units get nothing and stamp
    nothing (concern 02 semantics).
  - Double gate: profile opt-in AND OMP_SQUAD_MEMBRANE_PROFILES=1.
- Breaker (real, not ceremonial): threshold-tuner-cadence check comparing flagged cohort vs
  auto-champion baseline over reproducible cells only; past MIN_EDGE degradation over N units,
  HARD auto-disable the runtime setting + AttentionEvent explaining what tripped. Warn on
  unknown membrane:* token strings (typo = silent no-op otherwise).

## Cross-Repo Side Effects
None.

## Verify
Tests: toolGrants isolation; ACP no-stamp; breaker trips on a synthetic degraded cohort and the
setting reads disabled afterward. Live: scratch-daemon unit under omp with the token shows the
block in its system prompt; a judge verdict stays byte-exact on code/paths.
