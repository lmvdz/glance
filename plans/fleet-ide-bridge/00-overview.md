# Fleet-IDE bridge substrate (Epic B)

Parent: plans/fleet-first-ide/00-meta.md · Evidence: plans/research-terax-ai/BRIEF.md

## Outcome

Any OSC-aware terminal surfaces glance attention natively (cockpit bell lights up with zero cockpit code); one action jumps from any fleet surface into a unit's worktree in the operator's editor/cockpit; every ad-hoc harness CLI session in a registered project self-reports to the daemon — closing the attribution gap and creating Epic E's adoption substrate.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 osc-attention-emitter | terminal-native attention lane; cockpit bell for free | mechanical | src/osc-notify.ts (new), src/tui.ts, attention transition source shared with src/push.ts |
| 02 glance-open | fleet→worktree jump is the suite's core gesture | mechanical | src/index.ts (CLI), src/server.ts, webapp, src/config.ts |
| 03 harness-hook-reporting | attribution gap (omp one-shots, raw claude sessions); Epic E raw material | architectural | src/install-hooks.ts, src/ingest/, src/server.ts, src/doctor.ts |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02, 03 | disjoint files, no cross-deps — one loop iteration each, any order |
